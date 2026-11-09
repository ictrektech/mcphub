import type { Request, Response } from 'express';
import { authenticateVosToken, isVosAuthEnabled } from '../services/vosAuthService.js';
import { getDataService } from '../services/services.js';

export const vosLogin = async (req: Request, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isVosAuthEnabled()) {
    res.sendStatus(404);
    return;
  }
  try {
    const authorization = req.header('authorization');
    const user = await authenticateVosToken(
      authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined,
    );
    res.json({
      success: true,
      user: {
        username: user.username,
        displayName: user.displayName,
        isAdmin: user.isAdmin,
        permissions: getDataService().getPermissions(user),
      },
    });
  } catch {
    // Fetch errors can contain headers/credentials. Never log or echo them.
    res.status(401).json({ success: false, message: (req as Request & { t?: (key: string) => string }).t?.('vos.signInFailed') ?? 'VOS sign-in failed' });
  }
};
