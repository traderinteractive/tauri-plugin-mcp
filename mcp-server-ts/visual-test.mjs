import { spawn } from 'child_process';
import fs from 'fs';

const mcpServer = spawn('node', ['build/index.js'], {
  env: { 
    ...process.env, 
    TAURI_MCP_IPC_PATH: '/tmp/tauri-mcp.sock' 
  }
});

let requestId = 1;
let buffer = '';
const responses = new Map();

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = requestId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };
    
    responses.set(id, { resolve, reject });
    mcpServer.stdin.write(JSON.stringify(request) + '\n');
    
    setTimeout(() => {
      if (responses.has(id)) {
        responses.delete(id);
        reject(new Error('Request timeout'));
      }
    }, 30000);
  });
}

mcpServer.stdout.on('data', (data) => {
  buffer += data.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  
  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        if (response.id && responses.has(response.id)) {
          const { resolve, reject } = responses.get(response.id);
          responses.delete(response.id);
          
          if (response.error) {
            reject(new Error(response.error.message || JSON.stringify(response.error)));
          } else {
            resolve(response.result);
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }
});

mcpServer.stderr.on('data', (data) => {
  // Suppress logs
});

async function runTests() {
  try {
    console.log('🔧 Initializing MCP connection...');
    await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'visual-tester', version: '1.0.0' }
    });
    
    console.log('✓ MCP initialized\n');
    
    // Test 1: Get DOM structure
    console.log('📋 Test 1: Getting DOM structure...');
    const domResult = await sendRequest('tools/call', {
      name: 'get_dom',
      arguments: { window_label: 'main' }
    });
    
    const domContent = domResult.content?.[0]?.text || '';
    console.log(`✓ DOM retrieved: ${domContent.length} characters`);
    
    // Save DOM to file
    fs.writeFileSync('/tmp/skycode-dom.html', domContent);
    console.log('✓ DOM saved to /tmp/skycode-dom.html\n');
    
    // Test 2: Take screenshot
    console.log('📸 Test 2: Taking screenshot...');
    const screenshotResult = await sendRequest('tools/call', {
      name: 'take_screenshot',
      arguments: { window_label: 'main' }
    });
    
    const screenshotData = screenshotResult.content?.[0]?.text || '';
    console.log(`✓ Screenshot captured: ${screenshotData.length} bytes`);
    
    if (screenshotData.includes('base64,')) {
      const base64Data = screenshotData.split('base64,')[1];
      fs.writeFileSync('/tmp/skycode-screenshot.png', Buffer.from(base64Data, 'base64'));
      console.log('✓ Screenshot saved to /tmp/skycode-screenshot.png\n');
    } else {
      console.log('⚠ Screenshot data format:', screenshotData.substring(0, 200) + '...\n');
    }
    
    // Test 3: Execute JS to get window info
    console.log('🔍 Test 3: Getting window dimensions...');
    const windowInfo = await sendRequest('tools/call', {
      name: 'execute_js',
      arguments: {
        code: `JSON.stringify({
          width: window.innerWidth,
          height: window.innerHeight,
          url: window.location.href,
          title: document.title
        })`
      }
    });
    
    const info = JSON.parse(windowInfo.content?.[0]?.text || '{}');
    console.log('✓ Window info:', info);
    
    // Test 4: Check for React errors
    console.log('\n⚠️  Test 4: Checking for React errors...');
    const errorsCheck = await sendRequest('tools/call', {
      name: 'execute_js',
      arguments: {
        code: `
          const errors = [];
          // Check for error boundaries
          const errorElements = document.querySelectorAll('[data-error], .error, .error-boundary');
          errorElements.forEach(el => {
            errors.push({
              type: 'error-element',
              text: el.textContent?.substring(0, 100),
              className: el.className
            });
          });
          
          // Check console errors
          JSON.stringify({ errors, errorCount: errors.length });
        `
      }
    });
    
    const errorData = JSON.parse(errorsCheck.content?.[0]?.text || '{}');
    if (errorData.errorCount > 0) {
      console.log('⚠ Found errors:', errorData);
    } else {
      console.log('✓ No visible errors found');
    }
    
    // Test 5: Get all interactive elements
    console.log('\n🎯 Test 5: Finding interactive elements...');
    const elements = await sendRequest('tools/call', {
      name: 'execute_js',
      arguments: {
        code: `
          const buttons = document.querySelectorAll('button');
          const inputs = document.querySelectorAll('input, textarea');
          const links = document.querySelectorAll('a[href]');
          
          JSON.stringify({
            buttons: buttons.length,
            inputs: inputs.length,
            links: links.length,
            buttonTexts: Array.from(buttons).slice(0, 10).map(b => b.textContent?.trim()).filter(t => t)
          });
        `
      }
    });
    
    const elementsInfo = JSON.parse(elements.content?.[0]?.text || '{}');
    console.log('✓ Interactive elements:', elementsInfo);
    
    console.log('\n✅ Visual testing complete!');
    console.log('\nGenerated files:');
    console.log('  - /tmp/skycode-dom.html');
    console.log('  - /tmp/skycode-screenshot.png (if successful)');
    
    mcpServer.kill();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    mcpServer.kill();
    process.exit(1);
  }
}

runTests();

setTimeout(() => {
  console.error('\n✗ Tests timed out');
  mcpServer.kill();
  process.exit(1);
}, 60000);
