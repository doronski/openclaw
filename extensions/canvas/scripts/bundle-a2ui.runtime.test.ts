import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown, type OutputOptions, type RolldownOptions } from "rolldown";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { copyA2uiAssets } from "./copy-a2ui.mjs";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginDir, "../..");
const rootRequire = createRequire(path.join(repoRoot, "package.json"));

type CanvasApi = {
  applyMessages(messages: unknown[]): { ok: boolean; surfaces: string[] };
  getSurfaces(): string[];
  reset(): { ok: boolean };
};

type CanvasDom = { window: Window & typeof globalThis & { openclawA2UI: CanvasApi } };
// The installed JSDOM package has no declarations; type only the fixture API we use.
const { JSDOM } = rootRequire("jsdom") as {
  JSDOM: new (
    html: string,
    options: { runScripts: "outside-only"; pretendToBeVisual: boolean; url: string },
  ) => CanvasDom;
};

function renderedText(root: Element | ShadowRoot): string {
  if ("shadowRoot" in root && root.shadowRoot) {
    return renderedText(root.shadowRoot);
  }
  return [
    root.textContent,
    ...Array.from(root.querySelectorAll("*"), (element) =>
      element.shadowRoot ? renderedText(element.shadowRoot) : "",
    ),
  ].join(" ");
}

describe("Canvas packaged A2UI runtime", () => {
  let tempDir: string;
  let dom: CanvasDom;
  let api: CanvasApi;
  let moduleIds: string[];
  let imports: string[];

  beforeAll(async () => {
    const configPath = path.join(pluginDir, "src/host/a2ui-app/rolldown.config.mjs");
    const { default: config } = (await import(pathToFileURL(configPath).href)) as {
      default: RolldownOptions & { output: OutputOptions };
    };
    const { output, ...input } = config;
    const bundle = await rolldown(input);
    let code: string;
    try {
      const result = await bundle.generate(output);
      const chunk = result.output.find((entry) => entry.type === "chunk");
      if (!chunk || chunk.type !== "chunk") {
        throw new Error("Canvas build did not produce its browser bundle");
      }
      code = chunk.code;
      moduleIds = Object.keys(chunk.modules).map((id) => id.replaceAll("\\", "/"));
      imports = [...chunk.imports, ...chunk.dynamicImports];
    } finally {
      await bundle.close();
    }

    tempDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-canvas-package-"));
    const sourceDir = path.join(tempDir, "assets");
    const outDir = path.join(tempDir, "package/dist/canvas-host/a2ui");
    await fs.mkdir(sourceDir);
    await fs.copyFile(
      path.join(pluginDir, "src/host/a2ui/index.html"),
      path.join(sourceDir, "index.html"),
    );
    await fs.writeFile(path.join(sourceDir, "a2ui.bundle.js"), code);
    await copyA2uiAssets({ srcDir: sourceDir, outDir });
    // Execute the installed assets with no node_modules in the package fixture.
    dom = new JSDOM(await fs.readFile(path.join(outDir, "index.html"), "utf8"), {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      url: "https://canvas.example/",
    });
    // JSDOM does not provide this browser primitive used by A2UI text styles.
    Object.defineProperty(dom.window, "structuredClone", { value: structuredClone });
    dom.window.eval(await fs.readFile(path.join(outDir, "a2ui.bundle.js"), "utf8"));
    api = dom.window.openclawA2UI;
  });

  beforeEach(() => {
    api.reset();
  });

  afterAll(async () => {
    dom?.window.close();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ships only the patched root Zod runtime and needs no A2UI production install", async () => {
    const zodPackage = rootRequire("zod/package.json") as { version: string };
    const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, "package.json"), "utf8"));
    expect(zodPackage.version).toBe("4.6.6");
    expect(manifest.dependencies["@a2ui/lit"]).toBeUndefined();
    expect(manifest.devDependencies["@a2ui/lit"]).toBe("0.10.1");
    const zodModules = moduleIds.filter((id) => id.includes("/zod/"));
    expect(zodModules.length).toBeGreaterThan(0);
    const zodEntry = rootRequire.resolve("zod").replaceAll("\\", "/");
    expect(zodModules.every((id) => id === zodEntry || id.includes("/zod/v4/"))).toBe(true);
    expect(moduleIds.some((id) => id.includes("/v0_9/"))).toBe(false);
    expect(imports).toEqual([]);
    await expect(fs.stat(path.join(tempDir, "package/node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(api.getSurfaces()).toEqual([]);
  });

  it("renders referenced components and bound data, then resets", async () => {
    expect(
      api.applyMessages([
        { beginRendering: { surfaceId: "s1", root: "row" } },
        { dataModelUpdate: { surfaceId: "s1", contents: [{ key: "name", valueString: "World" }] } },
        {
          surfaceUpdate: {
            surfaceId: "s1",
            components: [
              { id: "row", component: { Row: { children: { explicitList: ["text"] } } } },
              { id: "text", component: { Text: { text: { path: "/name" } } } },
            ],
          },
        },
      ]),
    ).toEqual({ ok: true, surfaces: ["s1"] });
    const host = dom.window.document.querySelector("openclaw-a2ui-host");
    expect(host).not.toBeNull();
    await expect.poll(() => renderedText(host!)).toContain("World");
    expect(api.reset()).toEqual({ ok: true });
    expect(api.getSurfaces()).toEqual([]);
  });

  it.each([
    ["one message action", {}, "exactly one of", "custom", []],
    [
      "one literal value",
      {
        surfaceUpdate: {
          surfaceId: "bad",
          components: [{ id: "text", component: { Text: { text: { literal: "a", path: "/a" } } } }],
        },
      },
      "exactly one property",
      "custom",
      ["surfaceUpdate", "components", 0, "component", "Text", "text"],
    ],
    [
      "component references",
      {
        surfaceUpdate: {
          surfaceId: "bad",
          components: [
            { id: "row", component: { Row: { children: { explicitList: ["missing"] } } } },
          ],
        },
      },
      "non-existent component",
      "custom",
      ["surfaceUpdate", "components"],
    ],
    [
      "strict message properties",
      { deleteSurface: { surfaceId: "bad", unexpected: true } },
      "Unrecognized key",
      "unrecognized_keys",
      ["deleteSurface"],
    ],
  ])("preserves validation errors for %s", (_name, message, detail, code, issuePath) => {
    try {
      api.applyMessages([message]);
      throw new Error("Expected Canvas validation to reject the message");
    } catch (error) {
      const validation = error as {
        name: string;
        issues: { code: string; path: (string | number)[]; message: string }[];
      };
      expect(validation.name).toBe("ZodError");
      expect(Array.isArray(validation.issues)).toBe(true);
      expect(validation.issues[0].code).toBe(code);
      expect(Array.from(validation.issues[0].path)).toEqual(issuePath);
      expect(validation.issues[0].message).toContain(detail);
    }
    expect(api.getSurfaces()).toEqual([]);
  });

  it("retains the recursive data depth limit", () => {
    let value: Record<string, unknown> = { key: "leaf", valueString: "valid" };
    for (let depth = 1; depth < 5; depth++) {
      value = { key: `level${depth}`, valueMap: [value] };
    }
    expect(() =>
      api.applyMessages([{ dataModelUpdate: { surfaceId: "depth", contents: [value] } }]),
    ).not.toThrow();
    expect(() =>
      api.applyMessages([
        { dataModelUpdate: { surfaceId: "depth", contents: [{ key: "root", valueMap: [value] }] } },
      ]),
    ).toThrow("valueMap recursion exceeded maximum depth of 5.");
  });
});
