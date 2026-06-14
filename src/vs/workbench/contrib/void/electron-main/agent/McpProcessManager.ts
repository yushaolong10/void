export interface McpProcessDescriptor {
	readonly serverName: string;
	readonly command: string;
	readonly status: 'starting' | 'running' | 'stopped' | 'failed';
	readonly error?: string;
}

export class McpProcessManager {
	private readonly processes = new Map<string, McpProcessDescriptor>();

	track(process: McpProcessDescriptor): void {
		this.processes.set(process.serverName, process);
	}

	list(): readonly McpProcessDescriptor[] {
		return [...this.processes.values()];
	}
}
