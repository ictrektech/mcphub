// VOS adaptation: application credentials have public-only MCP usage.
import { IUser, McpSettings } from '../types/index.js';
import { UserContextService } from './userContextService.js';
import { UserConfig } from '../types/index.js';

export class DataService {
  filterData(data: any[], user?: IUser): any[] {
    // Use passed user parameter if available, otherwise fall back to context
    const currentUser = user || UserContextService.getInstance().getCurrentUser();
    if (!currentUser || currentUser.isAdmin) {
      return data;
    } else {
      return data.filter((item) => {
        if ('applicationId' in currentUser && currentUser.applicationId) return item.visibility === 'public';
        if (item.owner === currentUser?.username) return true;
        // Visibility introduced in #817. Issue #1037 activates the restricted
        // 'group' scope for explicitly selected local usernames.
        if (item.visibility === 'public') return true;
        if (
          currentUser &&
          item.visibility === 'group' &&
          ((Array.isArray(item.sharedWithUsers) &&
            item.sharedWithUsers.includes(currentUser.username)) ||
            (Array.isArray(item.sharedWithUserGroups) &&
              item.sharedWithUserGroups.some((group: string) =>
                currentUser.userGroups?.includes(group),
              )))
        ) {
          return true;
        }
        return false;
      });
    }
  }

  filterSettings(settings: McpSettings, user?: IUser): McpSettings {
    // Use passed user parameter if available, otherwise fall back to context
    const currentUser = user || UserContextService.getInstance().getCurrentUser();
    if (!currentUser || currentUser.isAdmin) {
      const result = { ...settings };
      delete result.userConfigs;
      return result;
    } else {
      const result = { ...settings };
      // TODO: apply userConfig to filter settings as needed
      // const userConfig = settings.userConfigs?.[currentUser?.username || ''];
      delete result.userConfigs;
      return result;
    }
  }

  mergeSettings(all: McpSettings, newSettings: McpSettings, user?: IUser): McpSettings {
    // Use passed user parameter if available, otherwise fall back to context
    const currentUser = user || UserContextService.getInstance().getCurrentUser();
    if (!currentUser || currentUser.isAdmin) {
      // Copy every top-level key the caller actually supplied, and keep the
      // stored value for anything it left out. The previous hard-coded
      // whitelist silently dropped `remoteNodes`, `remoteServerBindings`,
      // `bearerKeys`, `prompts` and `resources`: a full save reported success
      // while the file kept the old value, so node registration, node-service
      // bindings and node-ops attach/detach never persisted in file mode.
      const result: McpSettings = { ...all };
      for (const [key, value] of Object.entries(newSettings)) {
        if (key === 'userConfigs' || value === undefined) continue;
        (result as unknown as Record<string, unknown>)[key] = value;
      }
      return result;
    } else {
      const result = JSON.parse(JSON.stringify(all));
      if (!result.userConfigs) {
        result.userConfigs = {};
      }
      const systemConfig = newSettings.systemConfig || {};
      const userConfig: UserConfig = {
        routing: systemConfig.routing
          ? {
              // TODO: only allow modifying certain fields based on userConfig permissions
            }
          : undefined,
      };
      result.userConfigs[currentUser?.username || ''] = userConfig;
      return result;
    }
  }

  getPermissions(user: IUser): string[] {
    if (user && user.isAdmin) {
      return ['*', 'x'];
    } else {
      return [''];
    }
  }
}
