import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService, IssuedTokens } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { Public } from '../common/decorators/public.decorator.js';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

/**
 * `x-client: mobile` opt-out: native apps (React Native, Flutter) can't
 * persist HttpOnly cookies reliably across launches. They send the
 * header and receive tokens in the JSON body for SecureStore /
 * Keychain. Web defaults to cookies (Server Components can read them,
 * no JS exposure to XSS).
 */
function isMobileClient(req: Request): boolean {
  return (req.headers['x-client'] as string | undefined) === 'mobile';
}

function deviceContext(req: Request) {
  return {
    userAgent: req.headers['user-agent']?.slice(0, 500),
    ip: req.ip,
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private config: ConfigService,
  ) {}

  // ── Registration ────────────────────────────────────────────────

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new business and owner account' })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(dto, deviceContext(req));
    return this.respondWithTokens(req, res, result, 201);
  }

  // ── Login ───────────────────────────────────────────────────────

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto, deviceContext(req));
    return this.respondWithTokens(req, res, result, 200);
  }

  // ── Refresh ─────────────────────────────────────────────────────

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  @ApiOperation({
    summary: 'Refresh access token (rotation + reuse detection)',
    description:
      'Reads refresh token from `refresh_token` cookie OR JSON body. On success, rotates the token and issues a new pair. On reuse (token was already rotated outside the 10s grace window), revokes the entire session family and forces re-login.',
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: RefreshDto,
  ) {
    const refreshToken =
      this.readCookie(req, REFRESH_COOKIE) ?? dto?.refreshToken ?? '';
    const issued = await this.authService.refresh(
      refreshToken,
      deviceContext(req),
    );
    return this.respondWithRotation(req, res, issued);
  }

  // ── Logout (current session only) ───────────────────────────────

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  @ApiOperation({
    summary: 'Logout and revoke the current session family',
  })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: RefreshDto,
  ) {
    const refreshToken =
      this.readCookie(req, REFRESH_COOKIE) ?? dto?.refreshToken;
    await this.authService.logout(refreshToken);
    this.clearCookies(res);
    return { message: 'Logged out' };
  }

  // ── Current user (dashboard boot) ───────────────────────────────

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({
    summary: 'Get current authenticated user profile + business',
    description:
      'Called by the dashboard on page load / SSR / new tab when the session cookie is present but in-memory client state is empty. Returns the same shape as login() minus tokens.',
  })
  me(@Req() req: Request) {
    return this.authService.me(req.user!.userId!);
  }

  // ── Per-device sessions (dashboard UX) ──────────────────────────

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({
    summary: 'List active sessions for the current user',
    description:
      'One row per session family (= per device login). Used by the dashboard "Devices" tab to let the user revoke specific sessions.',
  })
  listSessions(@Req() req: Request) {
    return this.authService.listSessions(req.user!.userId!);
  }

  @ApiBearerAuth()
  @Delete('sessions/:familyId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a specific session family (logout one device)',
  })
  async revokeSession(
    @Req() req: Request,
    @Param('familyId') familyId: string,
  ) {
    await this.authService.revokeSession(req.user!.userId!, familyId);
    return { message: 'Session revoked' };
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private respondWithTokens(
    req: Request,
    res: Response,
    payload: {
      accessToken: string;
      refreshToken: string;
      [key: string]: unknown;
    },
    statusCode: number,
  ) {
    res.status(statusCode);
    if (isMobileClient(req)) {
      // Mobile: tokens in body for SecureStore. No cookies.
      return payload;
    }
    // Web: HttpOnly cookies + body without tokens (frontend never
    // touches the JWT in JS — Server Components read via cookies()).
    this.setCookies(res, payload.accessToken, payload.refreshToken);
    const { accessToken, refreshToken, ...rest } = payload;
    void accessToken;
    void refreshToken;
    return rest;
  }

  private respondWithRotation(
    req: Request,
    res: Response,
    issued: IssuedTokens,
  ) {
    if (isMobileClient(req)) {
      return {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresAt: issued.refreshExpiresAt,
      };
    }
    this.setCookies(res, issued.accessToken, issued.refreshToken);
    return { ok: true };
  }

  private setCookies(res: Response, accessToken: string, refreshToken: string) {
    const isProd = process.env['NODE_ENV'] === 'production';
    const domain = this.config.get<string>('COOKIE_DOMAIN'); // e.g. ".mibooking.com" — undefined in dev
    const accessTtlMs = 15 * 60 * 1000;
    const refreshTtlMs = 30 * 24 * 60 * 60 * 1000;

    res.cookie(ACCESS_COOKIE, accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: accessTtlMs,
      ...(domain ? { domain } : {}),
    });
    res.cookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: refreshTtlMs,
      ...(domain ? { domain } : {}),
    });
  }

  private clearCookies(res: Response) {
    const domain = this.config.get<string>('COOKIE_DOMAIN');
    res.clearCookie(ACCESS_COOKIE, { path: '/', ...(domain ? { domain } : {}) });
    res.clearCookie(REFRESH_COOKIE, { path: '/', ...(domain ? { domain } : {}) });
  }

  private readCookie(req: Request, name: string): string | undefined {
    const cookies = (req as { cookies?: Record<string, string> }).cookies;
    return cookies?.[name];
  }
}
