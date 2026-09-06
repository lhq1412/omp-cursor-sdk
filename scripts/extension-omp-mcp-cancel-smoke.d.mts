export function buildExtensionOmpMcpCancelEvidence(probe?: {
	status: string;
	gap: boolean | null;
	thirdArg: string | null;
	path?: string;
}): {
	status: string;
	lane: string;
	hostCancelGap: string;
	hostCancelGapOpen: boolean;
	probeThirdArg: string | null;
	probeSourcePath?: string;
	installedHostPackageVersion: string;
	spawnedOmpVersion: string;
	proposalDoc: string;
	liveCancelRunnable: boolean;
	nextSteps: string[];
};
export function runCancelProbeSelfTest(): {
	ok: boolean;
	failures: unknown[];
	caseCount: number;
};
export function runExtensionOmpMcpCancelSmoke(argv?: string[]): Promise<
	| { status: "help" }
	| { status: "self-test-pass"; caseCount: number }
	| {
			status: string;
			lane: string;
			hostCancelGap: string;
			hostCancelGapOpen: boolean;
			probeThirdArg: string | null;
			probeSourcePath?: string;
			installedHostPackageVersion: string;
			spawnedOmpVersion: string;
			proposalDoc: string;
			liveCancelRunnable: boolean;
			nextSteps: string[];
	  }
>;
