const UNITS: Record<string, number> = {
	b: 1,
	kb: 1024,
	mb: 1024 * 1024,
	gb: 1024 * 1024 * 1024,
};

/**
 * Parse a human-friendly size string (`"10MB"`, `"512KB"`, `"2GB"`) into
 * an integer byte count. Accepts decimals (`"1.5MB" → 1572864`) and is
 * case-insensitive.
 *
 * @param value - the size string or a plain number (returned unchanged).
 * @returns the equivalent byte count as an integer.
 * @throws when the string can't be parsed.
 *
 * @internal
 */
export function parseSize(value: string | number): number {
	if (typeof value === "number") return value;
	const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
	if (!match) {
		throw new Error(`invalid size "${value}"`);
	}
	const num = Number.parseFloat(match[1] ?? "0");
	const unit = (match[2] ?? "b").toLowerCase();
	const mult = UNITS[unit] ?? 1;
	return Math.floor(num * mult);
}
