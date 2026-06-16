import { describe, expect, test } from "bun:test";
import { parseSize } from "@/internal/parse-size";

describe("parseSize", () => {
	test("passes through numbers unchanged", () => {
		expect(parseSize(1024)).toBe(1024);
		expect(parseSize(0)).toBe(0);
	});

	test("parses bytes without unit", () => {
		expect(parseSize("500")).toBe(500);
	});

	test("parses KB / MB / GB units (case-insensitive)", () => {
		expect(parseSize("1KB")).toBe(1024);
		expect(parseSize("1mb")).toBe(1024 * 1024);
		expect(parseSize("2GB")).toBe(2 * 1024 * 1024 * 1024);
	});

	test("accepts decimal values", () => {
		expect(parseSize("1.5MB")).toBe(Math.floor(1.5 * 1024 * 1024));
	});

	test("tolerates whitespace and explicit 'B' unit", () => {
		expect(parseSize(" 256B ")).toBe(256);
	});

	test("throws on garbage input", () => {
		expect(() => parseSize("not-a-size")).toThrow(/invalid size/);
	});
});
