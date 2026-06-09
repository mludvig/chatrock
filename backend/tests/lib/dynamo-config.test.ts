import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}))
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockReturnValue({}),
  },
  GetCommand: jest.fn(),
  PutCommand: jest.fn(),
  QueryCommand: jest.fn(),
  UpdateCommand: jest.fn(),
  DeleteCommand: jest.fn(),
}))

// Import AFTER mocks are in place so the module-level code runs with the mocks
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../src/lib/dynamo')

test('DocumentClient is created with removeUndefinedValues: true', () => {
  expect(DynamoDBDocumentClient.from).toHaveBeenCalledWith(
    expect.anything(),
    { marshallOptions: { removeUndefinedValues: true } },
  )
})
