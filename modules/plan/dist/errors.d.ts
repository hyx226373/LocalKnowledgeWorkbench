export declare class PlanError extends Error {
    readonly code: "not_found" | "unknown_step" | "not_approved" | "not_migrated" | "invalid" | "user_approval_required" | "approval_stale";
    constructor(code: PlanError["code"], message: string);
}
