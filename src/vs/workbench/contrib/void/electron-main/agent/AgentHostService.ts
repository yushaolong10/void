export interface AgentHostDescriptor {
	readonly id: string;
	readonly status: 'starting' | 'ready' | 'stopped' | 'failed';
	readonly error?: string;
}

export class AgentHostService {
	private readonly hosts = new Map<string, AgentHostDescriptor>();

	track(host: AgentHostDescriptor): void {
		this.hosts.set(host.id, host);
	}

	list(): readonly AgentHostDescriptor[] {
		return [...this.hosts.values()];
	}
}
