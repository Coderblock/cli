// `coderblock upgrade [<name>]` — refetch skill manifest and reinstall any
// outdated skills for the target project.

import fs from 'node:fs';
import path from 'node:path';
import { installSkillsForProject, LOCAL_CONFIG_FILENAME, readLocalConfig } from './init.js';
import { fatal, log } from './common.js';

export async function upgradeCommand(nameOrDir: string | undefined): Promise<void> {
  const targetDir = nameOrDir
    ? path.resolve(process.cwd(), nameOrDir)
    : process.cwd();

  if (!fs.existsSync(path.join(targetDir, LOCAL_CONFIG_FILENAME))) {
    fatal(new Error(`No ${LOCAL_CONFIG_FILENAME} in ${targetDir}. Run \`coderblock init\` or \`coderblock pull\` first.`));
  }
  const local = readLocalConfig(targetDir);
  try {
    const installed = await installSkillsForProject(targetDir, {
      category: local.category,
      frontendOnly: local.has_backend === false,
    });
    log.ok(`Upgrade complete. Skills: ${installed.join(', ') || '(none)'}`);
  } catch (err) {
    fatal(err);
  }
}
