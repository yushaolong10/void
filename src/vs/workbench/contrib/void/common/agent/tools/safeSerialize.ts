const MAX_DEPTH = 8;
const MAX_KEYS = 80;

const toSerializable = (value: unknown, seen: WeakSet<object>, depth: number): unknown => {
	if (value === null || value === undefined) return value;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'function') return '[Function]';
	if (typeof value !== 'object') return String(value);
	if (seen.has(value)) return '[Circular]';
	if (depth >= MAX_DEPTH) return '[MaxDepth]';

	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.slice(0, MAX_KEYS).map(item => toSerializable(item, seen, depth + 1));
		}

		if ('toString' in value && value.constructor?.name === 'URI') {
			return String(value);
		}

		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
			result[key] = toSerializable((value as Record<string, unknown>)[key], seen, depth + 1);
		}
		return result;
	}
	finally {
		seen.delete(value);
	}
};

export const safeStringify = (value: unknown, space?: number, maxLength = 20_000): string => {
	let serialized: string;
	try {
		serialized = JSON.stringify(toSerializable(value, new WeakSet<object>(), 0), null, space);
	}
	catch {
		serialized = String(value);
	}
	if (serialized.length <= maxLength) return serialized;
	return `${serialized.slice(0, maxLength)}\n...`;
};

export const safeCloneForStorage = (value: unknown, maxLength = 20_000): unknown => {
	if (typeof value === 'string') return value.length > maxLength ? `${value.slice(0, maxLength)}\n...` : value;
	if (value === null || value === undefined) return value;
	const serialized = safeStringify(value, undefined, maxLength);
	if (serialized.length >= maxLength) return { truncated: true, preview: serialized };
	try {
		return JSON.parse(serialized);
	}
	catch {
		return serialized;
	}
};
