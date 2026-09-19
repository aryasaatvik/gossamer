import { tegami, type TegamiPlugin } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

import rootPackage from "./package.json" with { type: "json" };

const REPOSITORY = "aryasaatvik/pagegraph";
const PACKAGE_ID = "npm:pagegraph";

const packageTag = (): TegamiPlugin => ({
  name: "pagegraph-tag",
  enforce: "post",
  initPublishPlan({ plan }) {
    const pkg = this.graph.get(PACKAGE_ID);
    const packagePlan = plan.packages.get(PACKAGE_ID);
    if (!pkg?.version || !packagePlan) return;

    packagePlan.git ??= {};
    packagePlan.git.tag = `v${pkg.version}`;
  },
});

if (rootPackage.name !== "pagegraph") {
  throw new Error("unexpected release package");
}

const paper = tegami({
  npm: {
    client: "bun",
    trustedPublish: {
      provider: "github",
      workflow: "publish.yml",
    },
  },
  packages: {
    "pagegraph": {},
  },
  plugins: [
    github({
      repo: REPOSITORY,
      pushTags: true,
      versionPr: {
        branch: "tegami/version-packages",
        base: "main",
        forceCreate: true,
        commit() {
          return { title: "chore(release): version packages" };
        },
        create() {
          const version = this.graph.get(PACKAGE_ID)?.version;
          return {
            title: version
              ? `chore(release): prepare pagegraph ${version}`
              : "chore(release): prepare pagegraph",
          };
        },
      },
      release: {
        create({ tag }) {
          return { title: tag };
        },
      },
    }),
    packageTag(),
  ],
});

await runCli(paper);
