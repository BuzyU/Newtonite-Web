export type TeamRole = 'viewer' | 'member' | 'lead' | 'admin';

export interface UserContext {
  id: string;
  email: string;
  name: string;
  isOrgAdmin: boolean;
  memberships: Map<string, TeamRole>; // team_id -> role
}

export type ActionType =
  | 'view_item'
  | 'create_item'
  | 'edit_item'
  | 'claim_item'
  | 'assign_item'
  | 'change_priority'
  | 'approve_item'
  | 'reject_item'
  | 'resolve_item'
  | 'close_item'
  | 'reopen_item'
  | 'comment_item'
  | 'manage_team'
  | 'archive_item';

export interface ItemResource {
  id: string;
  team_id: string;
  reporter_id: string;
  assignee_id: string | null;
  status: string;
  requires_approval: boolean;
  approval_status: string;
  version: number;
}

/**
 * Centralized authorization policy module: can(user, action, resource)
 * Controllers MUST NOT contain ad-hoc role checks.
 */
export function can(
  user: UserContext,
  action: ActionType,
  resource?: { teamId: string; item?: ItemResource }
): { allowed: boolean; reason?: string; isOrgAdminOverride?: boolean } {
  // 1. Org admin bypass check
  if (user.isOrgAdmin) {
    // Separation of duties rule still strictly applies to approval even for org admins
    // to preserve regulatory integrity: the approver must not be the reporter or current assignee!
    if (action === 'approve_item' && resource?.item) {
      if (resource.item.reporter_id === user.id) {
        return { allowed: false, reason: 'Separation of duties: The reporter cannot approve their own item.' };
      }
      if (resource.item.assignee_id === user.id) {
        return { allowed: false, reason: 'Separation of duties: The current assignee cannot approve their own item.' };
      }
    }

    return { allowed: true, isOrgAdminOverride: true };
  }

  if (!resource) {
    return { allowed: false, reason: 'Target resource context is required for authorization.' };
  }

  const role = user.memberships.get(resource.teamId);

  // If user does not belong to the team, they cannot do anything on it
  if (!role) {
    return { allowed: false, reason: 'User is not a member of this team.' };
  }

  switch (action) {
    case 'view_item':
      // Any team role (viewer, member, lead, admin) can view
      return { allowed: true };

    case 'create_item':
      // member, lead, admin can create. Viewer cannot.
      if (role === 'viewer') {
        return { allowed: false, reason: 'Viewers cannot create work items.' };
      }
      return { allowed: true };

    case 'edit_item':
      if (role === 'viewer') {
        return { allowed: false, reason: 'Viewers cannot edit work items.' };
      }
      if (role === 'lead' || role === 'admin') {
        return { allowed: true };
      }
      // Members can edit own or assigned items
      if (resource.item) {
        const isOwnerOrAssignee =
          resource.item.reporter_id === user.id || resource.item.assignee_id === user.id;
        if (isOwnerOrAssignee) {
          return { allowed: true };
        }
        return { allowed: false, reason: 'Members can only edit items they reported or are assigned to.' };
      }
      return { allowed: true };

    case 'claim_item':
      if (role === 'viewer') {
        return { allowed: false, reason: 'Viewers cannot claim work items.' };
      }
      return { allowed: true };

    case 'assign_item':
      // Only lead and admin can assign/reassign
      if (role === 'lead' || role === 'admin') {
        return { allowed: true };
      }
      return { allowed: false, reason: 'Only team leads and admins can assign or reassign items.' };

    case 'change_priority':
      // Only lead and admin can change priority
      if (role === 'lead' || role === 'admin') {
        return { allowed: true };
      }
      return { allowed: false, reason: 'Only team leads and admins can change item priority.' };

    case 'approve_item':
      // Approver must be lead or admin of team AND must NOT be reporter AND must NOT be assignee
      if (role !== 'lead' && role !== 'admin') {
        return { allowed: false, reason: 'Only team leads and admins can approve items.' };
      }
      if (resource.item) {
        if (resource.item.reporter_id === user.id) {
          return { allowed: false, reason: 'Separation of duties: The reporter cannot approve their own item.' };
        }
        if (resource.item.assignee_id === user.id) {
          return { allowed: false, reason: 'Separation of duties: The current assignee cannot approve their own item.' };
        }
      }
      return { allowed: true };

    case 'reject_item':
      if (role !== 'lead' && role !== 'admin') {
        return { allowed: false, reason: 'Only team leads and admins can reject approval requests.' };
      }
      return { allowed: true };

    case 'resolve_item':
      if (role !== 'lead' && role !== 'admin') {
        return { allowed: false, reason: 'Only team leads and admins can resolve items.' };
      }
      return { allowed: true };

    case 'close_item':
      if (role !== 'lead' && role !== 'admin') {
        return { allowed: false, reason: 'Only team leads and admins can close items.' };
      }
      return { allowed: true };

    case 'reopen_item':
      if (role !== 'lead' && role !== 'admin') {
        return { allowed: false, reason: 'Only team leads and admins can reopen items.' };
      }
      return { allowed: true };

    case 'comment_item':
      // member, lead, admin can comment. Viewer cannot comment.
      if (role === 'viewer') {
        return { allowed: false, reason: 'Viewers cannot add comments.' };
      }
      return { allowed: true };

    case 'archive_item':
      if (role !== 'lead' && role !== 'admin') {
        return { allowed: false, reason: 'Only team leads and admins can archive items.' };
      }
      return { allowed: true };

    case 'manage_team':
      if (role !== 'admin') {
        return { allowed: false, reason: 'Only team admins can manage team memberships.' };
      }
      return { allowed: true };

    default:
      return { allowed: false, reason: `Unknown action: ${action}` };
  }
}
