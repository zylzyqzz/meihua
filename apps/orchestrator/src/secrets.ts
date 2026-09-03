import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * VTube Studio tokens are deliberately kept out of SQLite, settings JSON and
 * logs. On Windows the token is protected for the current Windows user with
 * DPAPI; non-Windows development hosts simply report no stored token.
 */
function runPowerShell(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function readDpapiSecret(filePath: string): string | undefined {
  if (process.platform !== 'win32' || !existsSync(filePath)) return undefined;
  try {
    const encrypted = readFileSync(filePath, 'utf8').trim();
    if (!encrypted) return undefined;
    const encoded = Buffer.from(encrypted, 'utf8').toString('base64');
    const script = `$cipher=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $secure=ConvertTo-SecureString $cipher; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}`;
    return runPowerShell(script) || undefined;
  } catch {
    return undefined;
  }
}

export function writeDpapiSecret(filePath: string, plaintext: string): void {
  if (process.platform !== 'win32') throw new Error('DPAPI_SECRET_STORAGE_REQUIRES_WINDOWS');
  const encoded = Buffer.from(plaintext, 'utf8').toString('base64');
  const script = `$plain=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ConvertTo-SecureString $plain -AsPlainText -Force | ConvertFrom-SecureString`;
  const encrypted = runPowerShell(script);
  if (!encrypted) throw new Error('DPAPI_SECRET_ENCRYPTION_FAILED');
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, encrypted, { encoding: 'utf8', mode: 0o600 });
}

export function deleteDpapiSecret(filePath: string): void {
  if (existsSync(filePath)) unlinkSync(filePath);
}
