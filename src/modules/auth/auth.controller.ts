import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';

export class AuthController {
  private authService: AuthService;

  constructor() {
    this.authService = new AuthService();
  }

  login = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { email, password } = req.body;
    const result = await this.authService.login(email, password);
    ResponseHandler.success(res, 'Login successful', result);
  });

  register = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userData = req.body;
    const result = await this.authService.register(userData);
    ResponseHandler.success(res, 'User registered successfully', result, 201);
  });

  refreshToken = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { refreshToken } = req.body;
    const result = await this.authService.refreshToken(refreshToken);
    ResponseHandler.success(res, 'Token refreshed successfully', result);
  });

  logout = asyncHandler(async (_req: Request, res: Response, _next: NextFunction) => {
    ResponseHandler.success(res, 'Logout successful');
  });
}
