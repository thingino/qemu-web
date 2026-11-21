// Worker wrapper around wasm-runner.js
import { run, input } from './wasm-runner.js';
self.onmessage = ({ data }) => {
  if (data.type === 'input') input(data.bytes);
  else if (data.type === 'start') run(data, (msg, transfer) => self.postMessage(msg, transfer || []));
};
