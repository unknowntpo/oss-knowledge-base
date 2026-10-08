/** Lets Bun tests import `.vue` single-file components (script setup + template, no styles). */
import { plugin } from "bun";
import { compileScript, parse } from "vue/compiler-sfc";

let registered = false;

export function registerVuePlugin(): void {
  if (registered) return;
  registered = true;
  plugin({
    name: "vue-sfc",
    setup(build) {
      build.onLoad({ filter: /\.vue$/u }, async ({ path }) => {
        const { descriptor, errors } = parse(await Bun.file(path).text(), { filename: path });
        if (errors.length > 0) throw errors[0];
        const script = compileScript(descriptor, { id: path, inlineTemplate: true, isProd: false });
        return { contents: script.content, loader: "ts" };
      });
    },
  });
}
