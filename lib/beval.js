#!/usr/bin/env node
// Quick script to run JS in connected browser tab
const WebSocket = require('ws');

const RELAY_URL = 'ws://127.0.0.1:19988/cdp';

async function evaluate(script) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    let sessionId = null;
    let msgId = 0;
    const pending = new Map();

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: ++msgId, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
    });

    ws.on('error', reject);

    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.method === 'Target.attachedToTarget') {
        sessionId = msg.params.sessionId;
        // Enable Runtime
        ws.send(JSON.stringify({ id: ++msgId, method: 'Runtime.enable', params: {}, sessionId }));
      }
      
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
      
      // After Runtime.enable, run our script
      if (msg.id === 2 && sessionId) {
        const evalId = ++msgId;
        ws.send(JSON.stringify({
          id: evalId,
          method: 'Runtime.evaluate',
          params: { expression: script, returnByValue: true, awaitPromise: true },
          sessionId
        }));
        pending.set(evalId, (result) => {
          ws.close();
          if (result.result?.result?.value !== undefined) {
            resolve(result.result.result.value);
          } else if (result.result?.exceptionDetails) {
            reject(new Error(result.result.exceptionDetails.text));
          } else {
            resolve(result);
          }
        });
      }
    });

    setTimeout(() => { 
      ws.close();
      reject(new Error('Timeout')); 
    }, 10000);
  });
}

// Export for programmatic use
module.exports = { evaluate };

// CLI mode
if (require.main === module) {
  const script = process.argv[2] || 'document.title';
  evaluate(script)
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
