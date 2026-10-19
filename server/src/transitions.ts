export type ItemStatus =
  | 'new'
  | 'triaged'
  | 'in_progress'
  | 'blocked'
  | 'awaiting_approval'
  | 'resolved'
  | 'closed';

export interface TransitionContext {
  currentStatus: ItemStatus;
  targetStatus: ItemStatus;
  requiresApproval: boolean;
  assigneeId: string | null;
  resolutionNote?: string | null;
  rejectionNote?: string | null;
  actorRole?: string;
  isApprovalAction?: boolean;
  isRejectionAction?: boolean;
  isReopenAction?: boolean;
}

export interface TransitionValidationResult {
  valid: boolean;
  error?: string;
  nextApprovalStatus?: 'not_required' | 'pending' | 'approved' | 'rejected';
}

/**
 * Validates state transitions according to Newtonite operational workflow rules.
 * All state machine logic is strictly centralized in this module.
 */
export function validateTransition(ctx: TransitionContext): TransitionValidationResult {
  const { currentStatus, targetStatus } = ctx;

  // Closed items accept only reopen to triaged
  if (currentStatus === 'closed') {
    if (targetStatus === 'triaged' && ctx.isReopenAction) {
      return { valid: true };
    }
    return {
      valid: false,
      error: `Closed items cannot transition to '${targetStatus}'. Only reopening to 'triaged' is permitted.`,
    };
  }

  // Same status transition is a no-op / invalid
  if (currentStatus === targetStatus) {
    return {
      valid: false,
      error: `Item is already in status '${currentStatus}'.`,
    };
  }

  // 1. new -> triaged
  if (currentStatus === 'new') {
    if (targetStatus === 'triaged') {
      return { valid: true };
    }
    return {
      valid: false,
      error: `Illegal transition from 'new' to '${targetStatus}'. New items must first be 'triaged'.`,
    };
  }

  // 2. triaged -> in_progress
  if (currentStatus === 'triaged') {
    if (targetStatus === 'in_progress') {
      if (!ctx.assigneeId) {
        return {
          valid: false,
          error: "Workflow rule violation: Items entering 'in_progress' must have an assignee.",
        };
      }
      return { valid: true };
    }
    return {
      valid: false,
      error: `Illegal transition from 'triaged' to '${targetStatus}'. Triaged items can only transition to 'in_progress'.`,
    };
  }

  // 3. in_progress -> blocked | awaiting_approval | resolved
  if (currentStatus === 'in_progress') {
    if (targetStatus === 'blocked') {
      return { valid: true };
    }

    if (targetStatus === 'awaiting_approval') {
      if (!ctx.requiresApproval) {
        return {
          valid: false,
          error: "Illegal transition: Only items marked with 'requires_approval' can transition to 'awaiting_approval'.",
        };
      }
      return {
        valid: true,
        nextApprovalStatus: 'pending',
      };
    }

    if (targetStatus === 'resolved') {
      if (ctx.requiresApproval) {
        return {
          valid: false,
          error: "Workflow rule violation: Items requiring approval must be approved by a team lead before resolution.",
        };
      }
      if (!ctx.resolutionNote || ctx.resolutionNote.trim().length === 0) {
        return {
          valid: false,
          error: 'Workflow rule violation: Resolving an item requires a resolution_note.',
        };
      }
      return { valid: true };
    }

    return {
      valid: false,
      error: `Illegal transition from 'in_progress' to '${targetStatus}'.`,
    };
  }

  // 4. blocked -> in_progress
  if (currentStatus === 'blocked') {
    if (targetStatus === 'in_progress') {
      if (!ctx.assigneeId) {
        return {
          valid: false,
          error: "Workflow rule violation: Items entering 'in_progress' must have an assignee.",
        };
      }
      return { valid: true };
    }
    return {
      valid: false,
      error: `Illegal transition from 'blocked' to '${targetStatus}'. Blocked items can only return to 'in_progress'.`,
    };
  }

  // 5. awaiting_approval -> resolved (via approve) | in_progress (via reject)
  if (currentStatus === 'awaiting_approval') {
    if (targetStatus === 'resolved') {
      if (!ctx.isApprovalAction) {
        return {
          valid: false,
          error: "Items awaiting approval can only be resolved via explicit lead 'approve' action.",
        };
      }
      if (!ctx.resolutionNote || ctx.resolutionNote.trim().length === 0) {
        return {
          valid: false,
          error: 'Workflow rule violation: Resolving an item requires a resolution_note.',
        };
      }
      return {
        valid: true,
        nextApprovalStatus: 'approved',
      };
    }

    if (targetStatus === 'in_progress') {
      if (!ctx.isRejectionAction) {
        return {
          valid: false,
          error: "Items awaiting approval can only return to in_progress via explicit lead 'reject' action.",
        };
      }
      if (!ctx.rejectionNote || ctx.rejectionNote.trim().length === 0) {
        return {
          valid: false,
          error: 'Workflow rule violation: Rejecting an approval requires an explanatory note.',
        };
      }
      return {
        valid: true,
        nextApprovalStatus: 'rejected',
      };
    }

    return {
      valid: false,
      error: `Illegal transition from 'awaiting_approval' to '${targetStatus}'.`,
    };
  }

  // 6. resolved -> closed | triaged (via reopen)
  if (currentStatus === 'resolved') {
    if (targetStatus === 'closed') {
      return { valid: true };
    }
    if (targetStatus === 'triaged' && ctx.isReopenAction) {
      return { valid: true };
    }
    return {
      valid: false,
      error: `Illegal transition from 'resolved' to '${targetStatus}'. Resolved items can only be closed or reopened to 'triaged'.`,
    };
  }

  return {
    valid: false,
    error: `Illegal transition from '${currentStatus}' to '${targetStatus}'.`,
  };
}
