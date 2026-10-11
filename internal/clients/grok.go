package clients

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func (m *Manager) FindGrokPath() string {
	name := "grok"
	if m.opts.Platform == "win32" {
		name = "grok.exe"
	}
	if p, err := m.opts.LookPath("grok"); err == nil && p != "" && exists(p) {
		return p
	}
	candidates := []string{
		filepath.Join(m.opts.Home, ".bun", "bin", name),
		filepath.Join(m.opts.Home, ".grok", "bin", name),
		filepath.Join(m.opts.Home, ".local", "bin", name),
	}
	for _, p := range candidates {
		if exists(p) {
			return p
		}
	}
	return ""
}

func (m *Manager) grokStatus(port int) Target {
	path := m.GrokConfigPath()
	binPath := m.FindGrokPath()
	installed := exists(path) || binPath != ""
	text, _ := readText(path)
	targetBase := GrokBaseURL(port)
	connected := strings.Contains(text, targetBase)

	t := Target{
		ID:         Grok,
		Label:      "Grok",
		Installed:  installed,
		Status:     connectionStatus(installed, connected),
		ConfigPath: path,
		Logo:       "xai",
	}
	if !installed {
		t.Reason = "Grok CLI was not found on this machine."
	} else {
		if connected {
			t.BaseURL = targetBase
		}
		t.Surfaces = []Surface{{
			ID:         "cli",
			Label:      "Grok CLI",
			Status:     t.Status,
			ConfigPath: path,
			BaseURL:    t.BaseURL,
		}}
	}
	return t
}

func (m *Manager) GrokStatus(port int) Target {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.grokStatus(port)
}

func (m *Manager) applyGrok(opts ApplyOptions) (ApplyResult, error) {
	path := m.GrokConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return ApplyResult{}, err
	}
	if err := m.saveState("grok", []string{path}); err != nil {
		return ApplyResult{}, err
	}

	text, _ := readText(path)
	baseURL := GrokBaseURL(opts.Port)

	// Ensure [endpoints] table with xai_api_base_url and models_base_url
	newText := injectGrokEndpoints(text, baseURL)

	// If models are specified, update default model in [models]
	if len(opts.Models) > 0 {
		newText = injectGrokDefaultModel(newText, opts.Models[0])
	}

	if err := writeText(path, newText); err != nil {
		return ApplyResult{}, err
	}
	if err := m.recordApplied("grok", []string{path}); err != nil {
		return ApplyResult{}, err
	}

	target := m.grokStatus(opts.Port)
	return ApplyResult{Target: target, Written: []string{path}}, nil
}

func (m *Manager) restoreGrok() (Target, error) {
	path := m.GrokConfigPath()
	state, err := m.loadState("grok")
	if err != nil {
		return Target{}, err
	}

	if state != nil {
		if orig, ok, existed := originalFile(state, path); ok {
			if !existed {
				_ = os.Remove(path)
			} else {
				_ = writeText(path, orig)
			}
		}
		_ = m.clearState("grok")
	} else {
		// Clean up managed lines if state is missing
		text, _ := readText(path)
		cleaned := removeGrokEndpoints(text)
		_ = writeText(path, cleaned)
	}

	return m.grokStatus(8787), nil
}

func injectGrokEndpoints(tomlText, baseURL string) string {
	lines := strings.Split(tomlText, "\n")
	hasEndpoints := false
	var out []string

	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[endpoints]") {
			hasEndpoints = true
			out = append(out, line)
			out = append(out, fmt.Sprintf("xai_api_base_url = %q", baseURL))
			out = append(out, fmt.Sprintf("models_base_url = %q", baseURL))
			// Skip old endpoint values
			for i+1 < len(lines) {
				nextTrim := strings.TrimSpace(lines[i+1])
				if strings.HasPrefix(nextTrim, "[") {
					break
				}
				if strings.HasPrefix(nextTrim, "xai_api_base_url") || strings.HasPrefix(nextTrim, "models_base_url") {
					i++
					continue
				}
				out = append(out, lines[i+1])
				i++
			}
			continue
		}
		out = append(out, line)
	}

	if !hasEndpoints {
		out = append(out, "", "[endpoints]", fmt.Sprintf("xai_api_base_url = %q", baseURL), fmt.Sprintf("models_base_url = %q", baseURL))
	}
	return strings.Join(out, "\n")
}

func injectGrokDefaultModel(tomlText, model string) string {
	lines := strings.Split(tomlText, "\n")
	hasModels := false
	var out []string

	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[models]") {
			hasModels = true
			out = append(out, line)
			out = append(out, fmt.Sprintf("default = %q", model))
			for i+1 < len(lines) {
				nextTrim := strings.TrimSpace(lines[i+1])
				if strings.HasPrefix(nextTrim, "[") {
					break
				}
				if strings.HasPrefix(nextTrim, "default") && strings.Contains(nextTrim, "=") && !strings.HasPrefix(nextTrim, "default_reasoning") {
					i++
					continue
				}
				out = append(out, lines[i+1])
				i++
			}
			continue
		}
		out = append(out, line)
	}

	if !hasModels {
		out = append(out, "", "[models]", fmt.Sprintf("default = %q", model))
	}
	return strings.Join(out, "\n")
}

func removeGrokEndpoints(tomlText string) string {
	lines := strings.Split(tomlText, "\n")
	var out []string
	inEndpoints := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			inEndpoints = strings.HasPrefix(trimmed, "[endpoints]")
			if inEndpoints {
				continue
			}
		}
		if inEndpoints && (strings.HasPrefix(trimmed, "xai_api_base_url") || strings.HasPrefix(trimmed, "models_base_url")) {
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}
