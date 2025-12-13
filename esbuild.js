import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const extension = {
    entryPoints: ["src/extension/index.ts"],
    bundle: true,
    external: ["vscode"],
    platform: "node",
    outfile: "out/extension.js",
    define: {
        "process.env.NODE_ENV": '"production"',
    },
};

if (watch) {
    await esbuild.context(extension).then((ctx) => ctx.watch());
} else {
    await esbuild.build(extension);
}
