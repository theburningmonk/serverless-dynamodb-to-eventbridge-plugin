const _ = require("lodash");

class DynamoDbToEventBridgePlugin {
	constructor(serverless) {
		this.serverless = serverless;
		this.log = (msg, ...args) => serverless.cli.consoleLog(`dynamodb-to-eventbridge: ${msg}`, ...args);
		this.service = this.serverless.service.service;
		this.naming = this.serverless.providers.aws.naming;

		// see https://gist.github.com/HyperBrain/50d38027a8f57778d5b0f135d80ea406
		// for available lifecycle hooks
		this.hooks = {
			"after:package:compileEvents": this.execute.bind(this)
		};
	}

	execute() {
		this.stage = this.serverless.providers.aws.options.stage;
		this.region = this.serverless.providers.aws.options.region;
		const template = this.serverless.service.provider.compiledCloudFormationTemplate;

		const config = _.get(this.serverless.service, "custom.DynamoDbToEventBridgePlugin", {});
		this.eventBusName = config.eventBusName || "default";
		this.startingPosition = config.startingPosition || "TRIM_HORIZON";
		const excludeList = config.exclude || [];
		this.permissionsBoundary = config.permissionsBoundary;
		this.streamViewType = config.streamViewType || "NEW_AND_OLD_IMAGES";

		const resources = this.serverless.service.resources.Resources;
		const ddbTableLogicalIds = Object.keys(resources)
			.filter(x => resources[x].Type === "AWS::DynamoDB::Table")
			.filter(x => !excludeList.includes(x));

		if (_.isEmpty(ddbTableLogicalIds)) {
			this.log("No DynamoDB tables found (or they're all excluded), skipping...");
			return;
		}

		this.enableStreams(ddbTableLogicalIds);

		const newResources = this.generateResources(ddbTableLogicalIds);
		for (const [logicalId, resource] of newResources) {
			template.Resources[logicalId] = resource;
		}
	}

	enableStreams(ddbTableLogicalIds) {
		for (const logicalId of ddbTableLogicalIds) {
			this.log(`enabling StreamSpecification on [${logicalId}] (${this.streamViewType})`);

			const { Resources } = this.serverless.service.resources;
			const ddbTable = Resources[logicalId];
			ddbTable.Properties.StreamSpecification = {
				StreamViewType: this.streamViewType
			};
		}
	}

	generateResources(ddbTableLogicalIds) {
		return _.flatMap(ddbTableLogicalIds, ddbTableLogicalId => {
			const dynamoDb = this.serverless.service.resources.Resources[ddbTableLogicalId];
			const sseEnabled = _.get(dynamoDb, "Properties.SSESpecification.SSEEnabled", false);
			const kmsKeyId = _.get(dynamoDb, "Properties.SSESpecification.KMSMasterKeyId");

			if (sseEnabled) {
				this.log(`${ddbTableLogicalId} sseEnabled: [${sseEnabled}]`);
				this.log(`${ddbTableLogicalId} KMS id: [${kmsKeyId}]`);
			}

			const prefix = `DynamoDbToEventBridge${ddbTableLogicalId}`;
			const functionName = `${this.service}-${this.stage}-DynamoDB-to-EventBridge-${ddbTableLogicalId}`.substr(0, 64);
			const logGroupLogicalId = `${prefix}LogGroup`;
			const logGroup = this.generateLogGroup(functionName);
			const iamRoleLogicalId = `${prefix}LambdaExecution`;
			const iamRole = this.generateIamRole(ddbTableLogicalId, logGroupLogicalId, kmsKeyId);
			const lambdaFunctionLogicalId = `${prefix}LambdaFunction`;
			const lambdaFunction = this.generateLambdaFunction(functionName, iamRoleLogicalId);
			const eventSourceMappingLogicalId = `${prefix}EventSourceMapping`;
			const eventSourceMapping = this.generateEventSourceMapping(
				ddbTableLogicalId,
				lambdaFunctionLogicalId,
				iamRoleLogicalId
			);

			// [logicalId, resource]
			return [
				[logGroupLogicalId, logGroup],
				[iamRoleLogicalId, iamRole],
				[lambdaFunctionLogicalId, lambdaFunction],
				[eventSourceMappingLogicalId, eventSourceMapping]
			];
		});
	}

	generateLogGroup(functionName) {
		return {
			Type: "AWS::Logs::LogGroup",
			Properties: {
				LogGroupName: this.naming.getLogGroupName(functionName)
			}
		};
	}

	generateIamRole(ddbTableLogicalId, logGroupLogicalId, kmsKeyId) {
		const eventBusArn = this.eventBusName.Ref
			? { "Fn::GetAtt": [this.eventBusName.Ref, "Arn"] }
			: { "Fn::Sub": `arn:aws:events:\${AWS::Region}:\${AWS::AccountId}:event-bus/${this.eventBusName}` };

		const statements = [
			{
				Effect: "Allow",
				Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
				Resource: [
					{
						"Fn::Sub": `\${${logGroupLogicalId}.Arn}:*:*`
					}
				]
			},
			{
				Effect: "Allow",
				Action: [
					"dynamodb:GetRecords",
					"dynamodb:GetShardIterator",
					"dynamodb:DescribeStream",
					"dynamodb:ListStreams"
				],
				Resource: [
					{
						"Fn::GetAtt": [ddbTableLogicalId, "StreamArn"]
					}
				]
			},
			{
				Effect: "Allow",
				Action: "events:PutEvents",
				Resource: eventBusArn
			}
		];

		if (kmsKeyId) {
			statements.push({
				Effect: "Allow",
				Action: "kms:Decrypt",
				Resource: kmsKeyId
			});
		}

		return {
			Type: "AWS::IAM::Role",
			Properties: {
				AssumeRolePolicyDocument: {
					Version: "2012-10-17",
					Statement: [
						{
							Effect: "Allow",
							Principal: {
								Service: ["lambda.amazonaws.com"]
							},
							Action: ["sts:AssumeRole"]
						}
					]
				},
				Path: "/",
				RoleName: `${this.service}-${this.stage}-DDB2EB-${ddbTableLogicalId}`,
				ManagedPolicyArns: [],
				PermissionsBoundary: this.permissionsBoundary,
				Policies: [
					{
						PolicyName: "lambda",
						PolicyDocument: {
							Version: "2012-10-17",
							Statement: statements
						}
					}
				]
			}
		};
	}

	generateLambdaFunction(functionName, iamRoleLogicalId) {
		return {
			Type: "AWS::Lambda::Function",
			DependsOn: [iamRoleLogicalId],
			Properties: {
				Code: {
					ZipFile: `
const DynamoDB = require('aws-sdk/clients/dynamodb')
const EventBridge = require('aws-sdk/clients/eventbridge')
const EventBridgeClient = new EventBridge()

const { EVENT_BUS_NAME } = process.env

// EventBridge only allows 10 events, and up to 256KB per PutEvents request
const MAX_BATCH_SIZE = 10
const MAX_BATCH_SIZE_BYTES = 256 * 1024

module.exports.handler = async ({ Records }) => {
const entries = Records.map(record => {
  const keys = DynamoDB.Converter.unmarshall(record.dynamodb.Keys)

  const newImage = record.eventName === 'INSERT' || record.eventName === 'MODIFY'
    ? DynamoDB.Converter.unmarshall(record.dynamodb.NewImage)
    : undefined

  const oldImage = record.eventName === 'REMOVE' || record.eventName === 'MODIFY'
    ? DynamoDB.Converter.unmarshall(record.dynamodb.OldImage)
    : undefined

  const approximateCreationDateTime = new Date(record.dynamodb.ApproximateCreationDateTime * 1000)

  // arn:aws:dynamodb:us-east-1:123456789012:table/ExampleTableWithStream/stream/2015-06-27T00:48:05.899
  const [prefix, tableName, _stream, _streamTimestamp] = record.eventSourceARN.split('/')
  const tableArn = prefix + '/' + tableName

  return {
    EventBusName: EVENT_BUS_NAME,
    Time: approximateCreationDateTime,
    Source: 'dynamodb.' + tableName,
    Resources: [tableArn],
    DetailType: record.eventName,
    Detail: JSON.stringify({
      awsRegion: record.awsRegion,
      keys,
      newImage,
      oldImage,
      sizeBytes: record.dynamodb.SizeBytes,
      approximateCreationDateTime,
      dynamodbStreamSequenceNumber: record.dynamodb.SequenceNumber,
      dynamodbStreamArn: record.eventSourceARN,
    })
  }
})

let batch = []
let batchSize = 0

const flush = async () => {
  if (batch.length === 0) {
    return
  }

  await EventBridgeClient.putEvents({
    Entries: batch
  }).promise()

  batch = []
  batchSize = 0
}

for (const entry of entries) {
  const entrySize = calculateEntrySize(entry)
  if ((batchSize + entrySize) >= MAX_BATCH_SIZE_BYTES) {
    await flush()
  }

  batch.push(entry)
  batchSize += entrySize

  if (batch.length === MAX_BATCH_SIZE) {
    await flush()
  }
}

await flush()
}

// see this link for more detail
// https://docs.aws.amazon.com/eventbridge/latest/userguide/calculate-putevents-entry-size.html
function calculateEntrySize (entry) {
let size = 14 // Time
size += Buffer.from(entry.Source, 'utf-8').length
size += Buffer.from(entry.DetailType, 'utf-8').length
size += Buffer.from(entry.Detail, 'utf-8').length
for (const resource of entry.Resources) {
  size += Buffer.from(resource, 'utf-8').length
}

return size
}
          `
				},
				FunctionName: functionName,
				Handler: "index.handler",
				MemorySize: 256,
				Runtime: "nodejs12.x",
				Timeout: 10,
				Environment: {
					Variables: {
						STAGE: this.stage,
						AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
						EVENT_BUS_NAME: this.eventBusName
					}
				},
				Role: {
					"Fn::GetAtt": [iamRoleLogicalId, "Arn"]
				}
			}
		};
	}

	generateEventSourceMapping(ddbTableLogicalId, functionLogicalId, iamRoleLogicalId) {
		return {
			Type: "AWS::Lambda::EventSourceMapping",
			DependsOn: [iamRoleLogicalId],
			Properties: {
				BatchSize: 10,
				EventSourceArn: {
					"Fn::GetAtt": [ddbTableLogicalId, "StreamArn"]
				},
				FunctionName: {
					"Fn::GetAtt": [functionLogicalId, "Arn"]
				},
				StartingPosition: this.startingPosition,
				Enabled: true
			}
		};
	}
}

module.exports = DynamoDbToEventBridgePlugin;
