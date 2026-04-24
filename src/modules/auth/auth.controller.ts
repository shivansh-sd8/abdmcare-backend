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
    const user = await this.authService.getUserById(id);
    ResponseHandler.success(res, 'User retrieved successfully', user);
  });

  updateUser = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const userData = req.body;
    const user = await this.authService.updateUser(id, userData);
    ResponseHandler.success(res, 'User updated successfully', user);
  });

  deleteUser = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.authService.deleteUser(id);
    ResponseHandler.success(res, 'User deleted successfully');
  });
}
