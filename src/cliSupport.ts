import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import * as yaml from 'js-yaml';

export interface CpxRuntimePaths {
  home: string;
  configDir: string;
  dataDir: string;
  logsDir: string;
  runDir: string;
  pidFile: string;
  daemonLog: string;
}

export interface CpxPidRecord {
  pid: number;
  startedAt: string;
  configDir: string;
  port: number;
}

export function resolveCpxHome(input?: string, env = process.env): string {
  const configured = input?.trim() || env.CPX_HOME?.trim();
  return resolve(configured || join(homedir(), '.cpx'));
}

export function cpxRuntimePaths(homeInput?: string): CpxRuntimePaths {
  const home = resolveCpxHome(homeInput);
  const runDir = join(home, 'run');
  return {
    home,
    configDir: join(home, 'config'),
    dataDir: join(home, 'data'),
    logsDir: join(home, 'logs'),
    runDir,
    pidFile: join(runDir, 'cpx.pid.json'),
    daemonLog: join(home, 'logs', 'cpx.log'),
  };
}

export function ensureRuntimeDirectories(paths: CpxRuntimePaths): void {
  for (const directory of [
    paths.home,
    paths.configDir,
    paths.dataDir,
    paths.logsDir,
    paths.runDir,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

export function initializeConfiguration(
  paths: CpxRuntimePaths,
  packageRoot: string,
): { created: string[]; skipped: string[] } {
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  const skipped: string[] = [];
  for (const name of ['config.yaml', 'permissions.yaml']) {
    const destination = join(paths.configDir, name);
    if (existsSync(destination)) {
      skipped.push(destination);
      continue;
    }
    const source = join(packageRoot, 'config', name.replace('.yaml', '.example.yaml'));
    if (!existsSync(source)) {
      throw new Error(`找不到配置模板: ${source}`);
    }
    writeFileSync(destination, readFileSync(source), { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(destination, 0o600);
    created.push(destination);
  }
  return { created, skipped };
}

export function readYamlObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = yaml.load(readFileSync(path, 'utf8'));
  if (parsed === undefined || parsed === null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} 的根节点必须是对象`);
  }
  return parsed as Record<string, unknown>;
}

export function writeYamlObject(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, yaml.dump(value, { noRefs: true, lineWidth: -1, sortKeys: false }), {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

export function getConfigValue(root: Record<string, unknown>, path: string): unknown {
  const segments = configPathSegments(path);
  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setConfigValue(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = configPathSegments(path);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
  return root;
}

export function isSecretConfigPath(path: string): boolean {
  return path.split('.').some(isSecretSegment);
}

export function redactConfig(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => redactConfig(item, path));
  if (!value || typeof value !== 'object') {
    return path.some(isSecretSegment) && value ? '***' : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      redactConfig(nested, [...path, key]),
    ]),
  );
}

function isSecretSegment(segment: string): boolean {
  const normalized = segment.toLowerCase().replace(/[-_]/g, '');
  return ['token', 'secret', 'password', 'apikey'].some(
    (suffix) => normalized === suffix || normalized.endsWith(suffix),
  );
}

export function parseConfigValue(value: string): unknown {
  const parsed = yaml.load(value);
  return parsed === undefined ? '' : parsed;
}

export function readPidRecord(path: string): CpxPidRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CpxPidRecord>;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.configDir !== 'string' ||
      typeof parsed.port !== 'number'
    ) {
      return undefined;
    }
    return parsed as CpxPidRecord;
  } catch {
    return undefined;
  }
}

export function writePidRecord(path: string, record: CpxPidRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

export function removePidRecord(path: string): void {
  rmSync(path, { force: true });
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function configPathSegments(path: string): string[] {
  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment))) {
    throw new Error('配置键必须使用点分隔的字母、数字、下划线或连字符');
  }
  return segments;
}
