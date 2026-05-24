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
    const currentUser = (req as any).user;
    const result = await this.authService.register(req.body, currentUser);
    ResponseHandler.created(res, 'User registered successfully', result);
  });

  superAdminSignup = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { secretKey, ...userData } = req.body;
    const result = await this.authService.superAdminSignup(userData, secretKey);
    ResponseHandler.created(res, 'Super Admin registered successfully', result);
  });

  refreshToken = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { refreshToken } = req.body;
    const result = await this.authService.refreshToken(refreshToken);
    ResponseHandler.success(res, 'Token refreshed successfully', result);
  });

  logout = asyncHandler(async (_req: Request, res: Response, _next: NextFunction) => {
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
