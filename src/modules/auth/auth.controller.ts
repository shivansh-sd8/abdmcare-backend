import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
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

    const isProduction = process.env.NODE_ENV === 'production';

    res.cookie('token', result.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      maxAge: 60 * 60 * 1000,
    });

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/v1/auth/refresh',
    });

    res.cookie('csrf-token', crypto.randomUUID(), { sameSite: 'strict' });

    ResponseHandler.success(res, 'Login successful', result);
  });

  register = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const result = await this.authService.register(req.body, currentUser);
    ResponseHandler.created(res, 'User registered successfully', result);
  });

  refreshToken = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const refreshToken = req.body.refreshToken || req.cookies?.refreshToken;
    if (!refreshToken) {
      ResponseHandler.error(res, 'Refresh token is required', 400);
      return;
    }
    const result = await this.authService.refreshToken(refreshToken);

    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', result.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      maxAge: 60 * 60 * 1000,
    });

    ResponseHandler.success(res, 'Token refreshed successfully', result);
  });

  logout = asyncHandler(async (_req: Request, res: Response, _next: NextFunction) => {
    res.clearCookie('token');
    res.clearCookie('refreshToken', { path: '/api/v1/auth/refresh' });
    res.clearCookie('csrf-token');
    ResponseHandler.success(res, 'Logout successful');
  });

  getAllUsers = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    const users = await this.authService.getAllUsers(user);
    ResponseHandler.success(res, 'Users retrieved successfully', users);
  });

  getUserById = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const currentUser = (req as any).user;
    const user = await this.authService.getUserById(id, currentUser);
    ResponseHandler.success(res, 'User retrieved successfully', user);
  });

  updateUser = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const userData = req.body;
    const currentUser = (req as any).user;
    const user = await this.authService.updateUser(id, userData, currentUser);
    ResponseHandler.success(res, 'User updated successfully', user);
  });

  deleteUser = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const currentUser = (req as any).user;
    await this.authService.deleteUser(id, currentUser);
    ResponseHandler.success(res, 'User deactivated successfully');
  });

  getProfile = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = (req as any).user.id;
    const result = await this.authService.getProfile(userId);
    ResponseHandler.success(res, 'Profile retrieved successfully', result);
  });

  updateProfile = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = (req as any).user.id;
    const result = await this.authService.updateProfile(userId, req.body);
    ResponseHandler.success(res, 'Profile updated successfully', result);
  });

  updateSettings = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = (req as any).user.id;
    const result = await this.authService.updateSettings(userId, req.body);
    ResponseHandler.success(res, 'Settings updated successfully', result);
  });

  forgotPassword = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { email } = req.body;
    const result = await this.authService.forgotPassword(email);
    ResponseHandler.success(res, result.message, result);
  });

  resetPassword = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { email, otp, newPassword } = req.body;
    const result = await this.authService.resetPassword(email, otp, newPassword);
    ResponseHandler.success(res, result.message);
  });

  updatePassword = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = (req as any).user.id;
    const { currentPassword, newPassword } = req.body;
    const result = await this.authService.updatePassword(userId, currentPassword, newPassword);
    ResponseHandler.success(res, result.message);
  });
}
