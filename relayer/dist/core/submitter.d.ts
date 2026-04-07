import { Match } from "./matcher.js";
export declare class Submitter {
    private provider;
    private wallet;
    private contract;
    constructor();
    submitSettle(match: Match): Promise<string>;
    private formatOrder;
    getAddress(): string;
}
