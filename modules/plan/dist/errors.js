export class PlanError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "PlanError";
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map