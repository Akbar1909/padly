// Runs before `npm run dev` / `npm run worker:dev`: the Shopify CLI needs Node 22.12+
// and otherwise crashes with a cryptic "enableCompileCache" SyntaxError.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `\nThis project needs Node 22.12 or newer, but this terminal is using Node ${process.versions.node}.\n` +
      "Run `nvm use` in this terminal (it reads .nvmrc), then try again.\n",
  );
  process.exit(1);
}
