import { z } from 'zod';

export const userSchema = z.object({
  id: z.string().uuid(),
  external_id: z.string(),
  email: z.string().email(),
  plan: z.enum(['free', 'pro']),
});

export const modSchema = z.object({
  id: z.string().uuid(),
  source: z.enum(['modrinth', 'curseforge', 'manual', 'zip_import']),
  external_id: z.string().nullable(),
  name: z.string(),
  mc_version: z.string(),
  loader: z.enum(['forge', 'fabric', 'neoforge', 'quilt', 'any']),
  is_server_side: z.number().or(z.boolean()).transform((v) => !!v),
  is_client_side: z.number().or(z.boolean()).transform((v) => !!v),
  is_lightweight_pack: z.number().or(z.boolean()).transform((v) => !!v),
});

export const presetSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  name: z.string(),
  mc_version: z.string(),
  loader: z.enum(['forge', 'fabric', 'neoforge', 'quilt']),
  source: z.enum(['manual', 'zip_import']),
  resource_profile: z.enum(['standard', 'performance']),
});

export const createPresetSchema = z.object({
  name: z.string().min(1).max(100),
  mc_version: z.string(),
  loader: z.enum(['forge', 'fabric', 'neoforge', 'quilt']),
  mod_ids: z.array(z.string().uuid()),
});

export type User = z.infer<typeof userSchema>;
export type Mod = z.infer<typeof modSchema>;
export type Preset = z.infer<typeof presetSchema>;

export const serverSessionResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['queued', 'provisioning', 'fallback', 'running', 'warning_sent', 'stopping', 'stopped', 'failed']),
  connectionAddress: z.string().nullable(),
  mcVersion: z.string(),
  loader: z.string(),
  presetName: z.string(),
  startedAt: z.string(),
  stoppedAt: z.string().nullable(),
  diskUsedMb: z.number(),
  currentPlayerCount: z.number(),
  providerInfo: z.string(),
});

export type ServerSessionResponse = z.infer<typeof serverSessionResponseSchema>;

export const appSettingsSchema = z.object({
  minecraftUuid: z.string().nullable().optional(),
  javaPath: z.string().nullable().optional(),
  defaultMemoryGb: z.number().min(4).max(64),
  usePlayitGg: z.boolean(),
  pvp: z.boolean(),
  difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']),
  gamemode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
  maxPlayers: z.number().min(1).max(200),
  allowFlight: z.boolean(),
  whiteList: z.boolean(),
  viewDistance: z.number().min(4).max(16),
  motd: z.string().max(100),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

