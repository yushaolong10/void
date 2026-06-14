import { URI } from '../../../../../../base/common/uri.js';

export interface RepoMapEntry {
	readonly uri: URI;
	readonly kind: 'file' | 'folder' | 'symbol';
	readonly label: string;
	readonly detail?: string;
}

export class RepoMapBuilder {
	private readonly entries: RepoMapEntry[] = [];

	add(entry: RepoMapEntry): this {
		this.entries.push(entry);
		return this;
	}

	buildText(): string {
		return this.entries
			.map(entry => `${entry.kind}\t${entry.uri.fsPath}\t${entry.label}${entry.detail ? `\t${entry.detail}` : ''}`)
			.join('\n');
	}
}
