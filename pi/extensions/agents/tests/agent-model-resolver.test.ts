import { describe, it, expect } from "bun:test";
import { AgentModelResolver } from "../agent-model-resolver";

const SAMPLE_ALIASES: Record<string, string> = {
  sonnet: "openrouter/anthropic/claude-sonnet-4-20250514",
  haiku: "openrouter/anthropic/claude-haiku-4-5-20250514",
  opus: "openrouter/anthropic/claude-opus-4-20250514",
};

describe("AgentModelResolver", () => {
  describe("resolve", () => {
    const resolver = new AgentModelResolver(SAMPLE_ALIASES);

    it("resolves known aliases to provider/model", () => {
      expect(resolver.resolve("sonnet")).toEqual({
        type: "concrete",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-20250514",
      });
    });

    it("resolves haiku alias", () => {
      expect(resolver.resolve("haiku")).toEqual({
        type: "concrete",
        provider: "openrouter",
        model: "anthropic/claude-haiku-4-5-20250514",
      });
    });

    it("resolves opus alias", () => {
      expect(resolver.resolve("opus")).toEqual({
        type: "concrete",
        provider: "openrouter",
        model: "anthropic/claude-opus-4-20250514",
      });
    });

    it('returns inherit for "inherit"', () => {
      expect(resolver.resolve("inherit")).toEqual({ type: "inherit" });
    });

    it("returns inherit for empty string", () => {
      expect(resolver.resolve("")).toEqual({ type: "inherit" });
    });

    it("passes through full provider/model syntax", () => {
      expect(resolver.resolve("anthropic/claude-sonnet-4-20250514")).toEqual({
        type: "concrete",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      });
    });

    it("returns error for unknown alias", () => {
      const result = resolver.resolve("unknown-model");
      expect(result.type).toBe("error");
      if (result.type === "error") {
        expect(result.message).toContain("Unknown model alias");
        expect(result.message).toContain("sonnet");
        expect(result.message).toContain("haiku");
      }
    });

    it("returns error for invalid provider/model format", () => {
      const result = resolver.resolve("no-slash");
      expect(result.type).toBe("error");
    });

    it("returns error for empty provider in provider/model", () => {
      const result = resolver.resolve("/model-only");
      expect(result.type).toBe("error");
    });
  });

  describe("fromJson", () => {
    it("creates resolver from JSON string", () => {
      const json = JSON.stringify(SAMPLE_ALIASES);
      const resolver = AgentModelResolver.fromJson(json);

      const result = resolver.resolve("sonnet");
      expect(result.type).toBe("concrete");
      if (result.type === "concrete") {
        expect(result.provider).toBe("openrouter");
      }
    });

    it("throws on non-object JSON", () => {
      expect(() => AgentModelResolver.fromJson("[]")).toThrow(/object/);
      expect(() => AgentModelResolver.fromJson('"string"')).toThrow(/object/);
      expect(() => AgentModelResolver.fromJson("null")).toThrow(/object/);
    });

    it("throws on non-string values", () => {
      expect(() => AgentModelResolver.fromJson('{"alias": 42}')).toThrow(/must be a string/);
    });

    it("loads the actual models.json from fixtures", async () => {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const json = await readFile(join(import.meta.dirname, "fixtures", "agents", "models.json"), "utf-8");

      const resolver = AgentModelResolver.fromJson(json);

      expect(resolver.resolve("sonnet").type).toBe("concrete");
      expect(resolver.resolve("haiku").type).toBe("concrete");
      expect(resolver.resolve("opus").type).toBe("concrete");
      expect(resolver.getAliases().sort()).toEqual(["haiku", "opus", "sonnet"]);
    });
  });

  describe("getAliases", () => {
    it("returns all known alias names", () => {
      const resolver = new AgentModelResolver(SAMPLE_ALIASES);
      expect(resolver.getAliases().sort()).toEqual(["haiku", "opus", "sonnet"]);
    });

    it("returns empty array for no aliases", () => {
      const resolver = new AgentModelResolver({});
      expect(resolver.getAliases()).toEqual([]);
    });
  });
});