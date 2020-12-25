# serverless-dynamodb-to-eventbridge-plugin

[![npm version](https://badge.fury.io/js/serverless-dynamodb-to-eventbridge-plugin.svg)](https://badge.fury.io/js/serverless-dynamodb-to-eventbridge-plugin)
[![MIT License](http://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)

Serverless framework plugin for converting DynamoDB events into events in EventBridge.

## Install

Run `npm install` in your Serverless project.

`$ npm install --save-dev serverless-dynamodb-to-eventbridge-plugin`

Add the plugin to your `serverless.yml` file

```yml
plugins:
  - serverless-dynamodb-to-eventbridge-plugin
```

By default, this plugin would:

- Enable DynamoDB stream on **ALL** DynamoDB tables configured in the `serverless.yml` file.
- Add a Lambda subscriber to each DynamoDB stream with the starting position `TRIM_HORIZON`.
- The Lambda subscribers would forward events to the `default` EventBridge bus.

The events look like this:

```json
{
  "Region": "us-east-1",
  "Source": "dynamodb.example-dev-Table3-O5HSVSJMF6W8",
  "Resources": [
    "arn:aws:dynamodb:us-east-1:1234567890:table/example-dev-Table3-O5HSVSJMF6W8"
  ],
  "Detail-Type": "REMOVE",
  "Detail": {
    "awsRegion": "us-east-1",
    "keys": {
      "id": "test2"
    },
    "oldImage": {
      "id": "test2"
    },
    "sizeBytes": 14,
    "approximateCreationDateTime": "2020-12-25T12:18:38.000Z",
    "dynamodbStreamSequenceNumber": "1894100000000005925624127",
    "dynamodbStreamArn": "arn:aws:dynamodb:us-east-1:1234567890:table/example-dev-Table3-O5HSVSJMF6W8/stream/2020-12-25T03:00:09.158"
  }
}

```

## Configurations

You can customize the behaviour of this plugin by adding this blob to your `serverless.yml`.

```yml
custom:
  DynamoDbToEventBridgePlugin:
    exclude: # optional
      - LogicalId
      - LogicalId
    eventBusName: String | { !Ref LogicalId } # optional
    startingPosition: LATEST | TRIM_HORIZON # optional (default TRIM_HORIZON)
```
