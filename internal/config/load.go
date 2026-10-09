package config

import (
	"fmt"
	"os"

	"github.com/xinyao27/jevonian/internal/paths"
)

// Load reads and parses the config file at paths.ConfigPath().
// When the file is missing, it returns (DefaultConfig(), "", nil) — same
// "start empty" behavior as TypeScript's `loadConfig() ?? parseConfig({})`.
// A valid JEVONIAN_PORT still applies, so a second instance with no config yet can
// start on its own port.
// The returned path is always the resolved config path (even when missing).
func Load() (Config, string, error) {
	path := paths.ConfigPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg := DefaultConfig()
			if port := envPort(); port > 0 {
				cfg.Listen.Port = port
			}
			return cfg, path, nil
		}
		return Config{}, path, fmt.Errorf("read config %s: %w", path, err)
	}
	cfg, err := ParseBytes(data)
	if err != nil {
		return Config{}, path, fmt.Errorf("parse config %s: %w", path, err)
	}
	return cfg, path, nil
}

// ParseBytes parses JSONC config bytes into a Config.
func ParseBytes(data []byte) (Config, error) {
	var raw any
	if err := UnmarshalJSONC(data, &raw); err != nil {
		return Config{}, err
	}
	return ParseConfig(raw)
}
