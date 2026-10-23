const agent = require('../src/agent');
agent.syncGranola('cli').then(r => { console.log(r); }).catch(e => { console.error(e.message); process.exit(1); });
