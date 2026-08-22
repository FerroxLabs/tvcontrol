#!/usr/bin/env node
/**
 * prepublishOnly guard: refuse to publish a package whose `tvcontrol` bin cannot be executed
 * as an MCP server.
 *
 * Both halves are load-bearing and only the first is a package.json string:
 *   - bin.tvcontrol must name src/server.js. npx/`bun x` resolve the bin whose NAME matches
 *     the package name, and Wayland Core speaks JSON-RPC to whatever that spawns. Pointing it
 *     at the human `tv` CLI puts a 45-line usage block on the protocol channel.
 *   - that file must start with a shebang. The installed shim is a symlink to the target file,
 *     so without `#!/usr/bin/env node` the SHELL runs it: `import: command not found`, exit 2.
 *     Checking only the bin string passes on exactly that broken build.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));

const target = pkg.bin?.tvcontrol;
if (target !== 'src/server.js') {
  throw new Error(
    `bin.tvcontrol is ${JSON.stringify(target)}; it must be "src/server.js" — npx resolves the ` +
      'package-name bin and Wayland Core needs the MCP server, not the CLI',
  );
}

const firstLine = readFileSync(path.join(repo, target), 'utf8').split('\n')[0];
if (firstLine !== '#!/usr/bin/env node') {
  throw new Error(
    `${target} line 1 is ${JSON.stringify(firstLine)}; it must be "#!/usr/bin/env node" — the ` +
      'installed bin shim is run by the shell and dies with "import: command not found" without it',
  );
}

console.log(`bin.tvcontrol -> ${target} (shebang present)`);
