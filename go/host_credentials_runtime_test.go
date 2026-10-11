package copilot_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	copilot "github.com/github/copilot-sdk/go"
	"github.com/github/copilot-sdk/go/rpc"
)

func TestAhpHostRuntimeUnknownExpiryOwnerAdmission(t *testing.T) {
	if os.Getenv("COPILOT_RUNTIME_HOST_E2E") != "1" {
		t.Skip("requires an explicitly selected source-built native runtime")
	}
	runtimePath := os.Getenv("COPILOT_CLI_PATH")
	if !filepath.IsAbs(runtimePath) {
		t.Fatal("COPILOT_CLI_PATH must select an absolute native runtime executable")
	}
	const token = "ghs_unknown_expiry_synthetic"
	var ownerLookups atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/user" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("owner validation did not use the supplied credential")
		}
		ownerLookups.Add(1)
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	home := t.TempDir()
	client := copilot.NewClient(&copilot.ClientOptions{
		Connection:       copilot.StdioConnection{Path: runtimePath},
		BaseDirectory:    home,
		WorkingDirectory: home,
		UseLoggedInUser:  copilot.Bool(false),
		Env: []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + home,
			"TMPDIR=" + home,
			"COPILOT_MC_BASE_URL=" + server.URL,
			"COPILOT_DEBUG_GITHUB_API_URL=" + server.URL,
			"COPILOT_AUTO_UPDATE=false",
		},
	})
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := client.Stop(); err != nil {
			t.Errorf("stop native runtime: %v", err)
		}
	}()
	// A loopback identity denial exercises native owner validation without
	// manufacturing admission or contacting a real control plane.
	for _, test := range []struct {
		name         string
		result       *copilot.GitHubTokenProviderResult
		error        string
		callbacks    int32
		ownerLookups int32
	}{
		{"unknown", copilot.GitHubTokenUnknownExpiryResult(&copilot.GitHubTokenUnknownExpiry{AccessToken: token}), "environment-owner credential could not be validated", 2, 1},
		{"known", copilot.GitHubTokenResult(&copilot.GitHubToken{AccessToken: token, ExpiresIn: 120}), "environment-owner credential could not be validated", 2, 1},
		{"zero", copilot.GitHubTokenResult(&copilot.GitHubToken{AccessToken: token}), "hosting credential provider must return a bearer", 1, 0},
		{"cancelled", copilot.GitHubTokenCancelled(), "hosting credential provider must return a bearer", 1, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			var callbacks atomic.Int32
			beforeLookups := ownerLookups.Load()
			kind := rpc.HostEnvironmentKindManagedSandbox
			_, err := client.StartAhpHost(ctx, &copilot.AhpHostOptions{
				GitHubEnvironment: &rpc.HostGitHubEnvironmentOptions{
					Name: "credential-policy-test", ComputeID: "agent:00000000-0000-4000-8000-000000000001", Kind: &kind,
				},
				GitHubTokenProvider: func(args copilot.GitHubTokenProviderArgs) (*copilot.GitHubTokenProviderResult, error) {
					call := callbacks.Add(1)
					reason := copilot.GitHubTokenRequestReasonInitial
					if call > 1 {
						reason = copilot.GitHubTokenRequestReasonRefresh
					}
					if args.SessionID != nil || args.Reason != reason {
						t.Error("unexpected hosting credential callback context")
					}
					return test.result, nil
				},
			})
			if err == nil || !strings.Contains(err.Error(), test.error) {
				t.Fatalf("expected %q, got %v", test.error, err)
			}
			if callbacks.Load() != test.callbacks {
				t.Errorf("expected %d credential callbacks, got %d", test.callbacks, callbacks.Load())
			}
			if lookups := ownerLookups.Load() - beforeLookups; lookups != test.ownerLookups {
				t.Errorf("expected %d owner lookups, got %d", test.ownerLookups, lookups)
			}
		})
	}
}
