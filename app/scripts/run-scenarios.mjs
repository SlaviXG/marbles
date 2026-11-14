import { runScenarios } from '../server/scenarios/runScenario.mjs';
const flags={};
const args=process.argv.slice(2);
for (let i=0; i<args.length; i++) {
  const arg=args[i];
  if (!arg.startsWith('--')) continue;
  const [name, ...value] = arg.slice(2).split('=');
  flags[name] = value.length ? value.join('=') : args[i+1] && !args[i+1].startsWith('--') ? args[++i] : true;
}
try {
  const timeoutMs = flags['timeout-min'] === undefined ? undefined : flags['timeout-min'] === true ? NaN : Number(flags['timeout-min']) * 60_000;
  const result=await runScenarios({selected:flags.scenarios?.split(','),agents:flags.agents?.split(','),dryRun:'dry-run' in flags,keep:'keep' in flags,timeoutMs,
    onProgress:({scenario,mode,status})=>console.error(`${scenario} ${mode} ${status}`)});
  console.log(result.table); console.log(result.markdown);
} catch(error) { console.error(error.message); process.exitCode=1; }
