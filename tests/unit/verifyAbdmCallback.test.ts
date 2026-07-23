import { Request, Response, NextFunction } from 'express';
import { verifyAbdmCallback } from '../../src/common/middleware/verifyAbdmCallback';

jest.mock('../../src/common/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/common/config/abdm', () => ({
  abdmConfig: {
    clientId: '',
    gatewayUrl: 'https://dev.abdm.gov.in/gateway',
  },
}));

function createMockReqRes(headers: Record<string, string> = {}) {
  const req = {
    headers,
    path: '/api/v3/hip/test',
    ip: '127.0.0.1',
  } as unknown as Request;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;

  const next = jest.fn() as NextFunction;

  return { req, res, next };
}

describe('verifyAbdmCallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should skip verification when no ABDM_CLIENT_ID configured', () => {
    const { req, res, next } = createMockReqRes();
    verifyAbdmCallback(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  describe('with ABDM_CLIENT_ID configured', () => {
    beforeEach(() => {
      jest.resetModules();
    });

    it('should reject requests without Authorization header', () => {
      jest.doMock('../../src/common/config/abdm', () => ({
        abdmConfig: {
          clientId: 'test-client-id',
          gatewayUrl: 'https://dev.abdm.gov.in/gateway',
        },
      }));
      jest.doMock('../../src/common/config/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }));

      const { verifyAbdmCallback: verifyFresh } = require('../../src/common/middleware/verifyAbdmCallback');
      const { req, res, next } = createMockReqRes({});
      verifyFresh(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Missing or invalid Authorization header' }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject requests with non-Bearer Authorization', () => {
      jest.doMock('../../src/common/config/abdm', () => ({
        abdmConfig: {
          clientId: 'test-client-id',
          gatewayUrl: 'https://dev.abdm.gov.in/gateway',
        },
      }));
      jest.doMock('../../src/common/config/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }));

      const { verifyAbdmCallback: verifyFresh } = require('../../src/common/middleware/verifyAbdmCallback');
      const { req, res, next } = createMockReqRes({ authorization: 'Basic abc123' });
      verifyFresh(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
