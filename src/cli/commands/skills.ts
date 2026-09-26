import * as Effect from "effect/Effect";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";

import coreSkill from "../../../skill-data/core/SKILL.md" with { type: "text" };
import { jsonFlag, printJson, printText, SeoCliError } from "../output";

const skills = { core: coreSkill } as const;

const nameArgument = Argument.String("name").pipe(
  Argument.withDescription("Bundled skill name from `pagegraph skills list`"),
);

const listCommand = Command.make("list", { json: jsonFlag }).pipe(
  Command.withDescription("List skills embedded in this Pagegraph CLI"),
  Command.withExamples([
    { command: "pagegraph skills list", description: "List embedded skills" },
    { command: "pagegraph skills list --json", description: "List skill names as JSON" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ json }) {
      const names = Object.keys(skills);
      if (json) return yield* printJson({ schemaVersion: 1, skills: names });
      return yield* printText(names.join("\n"));
    }),
  ),
);

const getCommand = Command.make("get", { name: nameArgument, json: jsonFlag }).pipe(
  Command.withDescription("Print a skill embedded in this Pagegraph CLI"),
  Command.withExamples([
    { command: "pagegraph skills get core", description: "Read Pagegraph integration guidance" },
    { command: "pagegraph skills get core --json", description: "Read the skill as JSON" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, json }) {
      if (!Object.hasOwn(skills, name)) {
        return yield* new SeoCliError({
          message: `Unknown skill "${name}". Run \`pagegraph skills list\` to see available names.`,
        });
      }
      const content = skills[name as keyof typeof skills];
      if (json) return yield* printJson({ schemaVersion: 1, name, content });
      return yield* printText(content.trimEnd());
    }),
  ),
);

/** Serve Pagegraph's version-matched agent guidance from the installed CLI. */
export const skillsCommand = Command.make("skills").pipe(
  Command.withDescription("List and read skills embedded in Pagegraph"),
  Command.withExamples([
    { command: "pagegraph skills list", description: "Discover embedded skills" },
    { command: "pagegraph skills get core", description: "Read the integration skill" },
  ]),
  Command.withSubcommands([listCommand, getCommand]),
);
