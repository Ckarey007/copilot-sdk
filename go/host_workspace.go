package copilot

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/github/copilot-sdk/go/internal/jsonrpc2"
	"github.com/github/copilot-sdk/go/rpc"
)

// AhpWorkspaceProvider serves one explicitly remote host, before sessions exist.
// It must never access the brain's workspace filesystem. Describe and Resolve
// are required; an omitted IO callback returns NotImplemented, never local IO.
// Calls may run concurrently. Repository materialization must precede Describe.
type AhpWorkspaceProvider struct {
	Describe func(context.Context, AhpWorkspaceCall) (*AhpWorkspaceDescription, error)
	Resolve  func(context.Context, AhpWorkspaceResolveRequest) (*AhpWorkspaceResolveResult, error)
	Read     func(context.Context, AhpWorkspaceResourceRequest[AhpWorkspaceReadParams]) (*AhpWorkspaceReadResult, error)
	Write    func(context.Context, AhpWorkspaceResourceRequest[AhpWorkspaceWriteParams]) error
	Stat     func(context.Context, AhpWorkspaceResourceRequest[AhpWorkspaceStatParams]) (*AhpWorkspaceStatResult, error)
	List     func(context.Context, AhpWorkspaceResourceRequest[AhpWorkspaceURIParams]) (*AhpWorkspaceListResult, error)
	Copy     func(context.Context, AhpWorkspaceResourceRequest[AhpWorkspaceCopyParams]) error
	Move     func(context.Context, AhpWorkspaceResourceRequest[AhpWorkspaceMoveParams]) error
	Delete   func(context.Context, AhpWorkspaceResourceRequest[AhpWorkspaceDeleteParams]) error
	Mkdir    func(context.Context, AhpWorkspaceResourceRequest[AhpWorkspaceURIParams]) error
	Access   func(context.Context, AhpWorkspaceResourceRequest[AhpWorkspaceAccessParams]) error
}

// RequestID identifies this invocation, not a session or permission grant.
// Never automatically retry a mutation after cancellation or an ambiguous error.
type AhpWorkspaceCall struct {
	HostID    string `json:"-"`
	RequestID string `json:"-"`
}

func (c *AhpWorkspaceCall) setWorkspaceCall(call AhpWorkspaceCall) { *c = call }

// Roots and exclusions are canonical absolute file URIs in the hands namespace.
// They remain fixed for this host's lifetime and do not describe durable SDK state.
type AhpWorkspaceDescription struct {
	Roots    []string `json:"roots"`
	Excluded []string `json:"excluded,omitempty"`
}

type AhpWorkspacePathMode string

const (
	AhpWorkspaceExisting        AhpWorkspacePathMode = "existing"
	AhpWorkspaceCreate          AhpWorkspacePathMode = "create"
	AhpWorkspaceMkdir           AhpWorkspacePathMode = "mkdir"
	AhpWorkspaceExistingSubtree AhpWorkspacePathMode = "existingSubtree"
	AhpWorkspaceCreateSubtree   AhpWorkspacePathMode = "createSubtree"
	AhpWorkspaceReadAccess      AhpWorkspacePathMode = "readAccess"
	AhpWorkspaceWriteAccess     AhpWorkspacePathMode = "writeAccess"
)

type AhpWorkspacePathRequest struct {
	URI  string               `json:"uri"`
	Mode AhpWorkspacePathMode `json:"mode"`
}

type AhpWorkspaceResolveRequest struct {
	AhpWorkspaceCall
	Paths           []AhpWorkspacePathRequest `json:"paths"`
	DiscoverProject bool                      `json:"discoverProject"`
	Roots           []string                  `json:"roots"`
	Excluded        []string                  `json:"excluded"`
}

// Project identity must come from the authorized remote repository, not an
// untrusted request. Native repository policy evaluates these facts.
type AhpWorkspaceProject struct {
	URI         string `json:"uri"`
	DisplayName string `json:"displayName"`
}

type AhpWorkspaceResolvedPath struct {
	URI         string               `json:"uri"`
	IsDirectory bool                 `json:"isDirectory"`
	IsSymlink   bool                 `json:"isSymlink"`
	Project     *AhpWorkspaceProject `json:"project,omitempty"`
}

type AhpWorkspaceResolveResult struct {
	Paths []AhpWorkspaceResolvedPath `json:"paths"`
}

type AhpWorkspaceGuardPath struct {
	RequestedURI string               `json:"requestedUri"`
	CanonicalURI string               `json:"canonicalUri"`
	Mode         AhpWorkspacePathMode `json:"mode"`
}

// Recheck these boundaries on hands at execution time. Resolution alone is not
// authorization to follow a replaced symlink. Writes must check hard links and
// etags against the actual opened handle before mutation and honor create-only
// atomically. Subtree operations must not consume an ancestor of an exclusion.
type AhpWorkspaceGuard struct {
	Roots    []string                `json:"roots"`
	Excluded []string                `json:"excluded"`
	Paths    []AhpWorkspaceGuardPath `json:"paths"`
}

type AhpWorkspaceResourceRequest[P any] struct {
	AhpWorkspaceCall
	Params P                 `json:"params"`
	Guard  AhpWorkspaceGuard `json:"guard"`
}

type AhpWorkspaceResourceMetadata struct {
	Channel string          `json:"channel"`
	Meta    json.RawMessage `json:"_meta,omitempty"`
}

type AhpWorkspaceURIParams struct {
	AhpWorkspaceResourceMetadata
	URI string `json:"uri"`
}

type AhpWorkspaceEncoding string

const (
	AhpWorkspaceUTF8   AhpWorkspaceEncoding = "utf-8"
	AhpWorkspaceBase64 AhpWorkspaceEncoding = "base64"
)

type AhpWorkspaceReadParams struct {
	AhpWorkspaceURIParams
	Encoding *AhpWorkspaceEncoding `json:"encoding,omitempty"`
}

type AhpWorkspaceReadResult struct {
	Data        string               `json:"data"`
	Encoding    AhpWorkspaceEncoding `json:"encoding"`
	ContentType *string              `json:"contentType,omitempty"`
}

type AhpWorkspaceWriteMode string

const (
	AhpWorkspaceTruncate AhpWorkspaceWriteMode = "truncate"
	AhpWorkspaceAppend   AhpWorkspaceWriteMode = "append"
	AhpWorkspaceInsert   AhpWorkspaceWriteMode = "insert"
)

type AhpWorkspaceWriteParams struct {
	AhpWorkspaceURIParams
	Data       string                 `json:"data"`
	Encoding   AhpWorkspaceEncoding   `json:"encoding"`
	CreateOnly *bool                  `json:"createOnly,omitempty"`
	Mode       *AhpWorkspaceWriteMode `json:"mode,omitempty"`
	Position   *int64                 `json:"position,omitempty"`
	IfMatch    *string                `json:"ifMatch,omitempty"`
}

type AhpWorkspaceStatParams struct {
	AhpWorkspaceURIParams
	FollowSymlinks *bool `json:"followSymlinks,omitempty"`
}

type AhpWorkspaceResourceType string

const (
	AhpWorkspaceFile      AhpWorkspaceResourceType = "file"
	AhpWorkspaceDirectory AhpWorkspaceResourceType = "directory"
	AhpWorkspaceSymlink   AhpWorkspaceResourceType = "symlink"
)

type AhpWorkspaceStatResult struct {
	URI         string                   `json:"uri"`
	Type        AhpWorkspaceResourceType `json:"type"`
	Size        *int64                   `json:"size,omitempty"`
	Mtime       *string                  `json:"mtime,omitempty"`
	Ctime       *string                  `json:"ctime,omitempty"`
	ContentType *string                  `json:"contentType,omitempty"`
	Etag        *string                  `json:"etag,omitempty"`
}

type AhpWorkspaceDirectoryEntry struct {
	Name string                   `json:"name"`
	Type AhpWorkspaceResourceType `json:"type"`
}

type AhpWorkspaceListResult struct {
	Entries []AhpWorkspaceDirectoryEntry `json:"entries"`
}

type AhpWorkspaceMoveParams struct {
	AhpWorkspaceResourceMetadata
	Source      string `json:"source"`
	Destination string `json:"destination"`
}

type AhpWorkspaceCopyParams struct {
	AhpWorkspaceMoveParams
	FailIfExists *bool `json:"failIfExists,omitempty"`
}

type AhpWorkspaceDeleteParams struct {
	AhpWorkspaceURIParams
	Recursive *bool `json:"recursive,omitempty"`
}

type AhpWorkspaceAccessParams struct {
	AhpWorkspaceURIParams
	Read  *bool `json:"read,omitempty"`
	Write *bool `json:"write,omitempty"`
}

// Only Code crosses the runtime boundary; provider diagnostics may contain
// credentials or file contents and are deliberately not included.
type AhpWorkspaceError struct {
	Code rpc.HostWorkspaceErrorCode
}

func (e *AhpWorkspaceError) Error() string { return "remote workspace: " + string(e.Code) }

func workspaceFailure(code string) *rpc.HostWorkspaceExecuteResult {
	value := rpc.HostWorkspaceErrorCode(code)
	return &rpc.HostWorkspaceExecuteResult{Payload: "{}", Error: &value}
}

func invokeWorkspace[P, R any](ctx context.Context, call AhpWorkspaceCall, payload string, callback func(context.Context, P) (R, error)) (any, error) {
	if callback == nil {
		return nil, &AhpWorkspaceError{Code: "notImplemented"}
	}
	var params P
	if err := json.Unmarshal([]byte(payload), &params); err != nil {
		return nil, &AhpWorkspaceError{Code: "invalidParams"}
	}
	if target, ok := any(&params).(interface{ setWorkspaceCall(AhpWorkspaceCall) }); ok {
		target.setWorkspaceCall(call)
	}
	return callback(ctx, params)
}

func invokeWorkspaceMutation[P any](ctx context.Context, call AhpWorkspaceCall, payload string, callback func(context.Context, P) error) (any, error) {
	if callback == nil {
		return nil, &AhpWorkspaceError{Code: "notImplemented"}
	}
	return invokeWorkspace(ctx, call, payload, func(ctx context.Context, params P) (struct{}, error) {
		return struct{}{}, callback(ctx, params)
	})
}

func (c *Client) handleHostWorkspaceExecute(ctx context.Context, raw json.RawMessage) (json.RawMessage, *jsonrpc2.Error) {
	result, err := c.executeHostWorkspace(ctx, raw)
	if err != nil {
		return nil, &jsonrpc2.Error{Code: -32603, Message: "workspace provider failed"}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, &jsonrpc2.Error{Code: -32603, Message: "workspace result encoding failed"}
	}
	return encoded, nil
}

func (c *Client) executeHostWorkspace(requestCtx context.Context, raw json.RawMessage) (result any, rpcErr error) {
	defer func() {
		if recover() != nil {
			result, rpcErr = workspaceFailure("internal"), nil
		}
	}()
	var request rpc.HostWorkspaceExecuteRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return workspaceFailure("invalidParams"), nil
	}
	c.ahp.mu.Lock()
	options, exists := c.ahp.hosts[request.HostID]
	c.ahp.mu.Unlock()
	if !exists || options.WorkspaceProvider == nil || options.workspaceContext == nil {
		return workspaceFailure("permissionDenied"), nil
	}
	ctx, cancel := context.WithTimeout(requestCtx, 25*time.Second)
	defer cancel()
	stop := context.AfterFunc(options.workspaceContext, cancel)
	defer stop()
	if options.workspaceContext.Err() != nil {
		cancel()
	}
	select {
	case options.workspaceSlots <- struct{}{}:
		defer func() { <-options.workspaceSlots }()
	case <-ctx.Done():
		return workspaceFailure("internal"), nil
	}
	if ctx.Err() != nil {
		return workspaceFailure("internal"), nil
	}
	call := AhpWorkspaceCall{HostID: request.HostID, RequestID: request.RequestID}
	provider := options.WorkspaceProvider
	var value any
	var err error
	switch request.Operation {
	case "describe":
		if provider.Describe == nil {
			return workspaceFailure("notImplemented"), nil
		}
		value, err = provider.Describe(ctx, call)
	case "resolve":
		value, err = invokeWorkspace(ctx, call, request.Payload, provider.Resolve)
	case "read":
		value, err = invokeWorkspace(ctx, call, request.Payload, provider.Read)
	case "write":
		value, err = invokeWorkspaceMutation(ctx, call, request.Payload, provider.Write)
	case "stat":
		value, err = invokeWorkspace(ctx, call, request.Payload, provider.Stat)
	case "list":
		value, err = invokeWorkspace(ctx, call, request.Payload, provider.List)
	case "copy":
		value, err = invokeWorkspaceMutation(ctx, call, request.Payload, provider.Copy)
	case "move":
		value, err = invokeWorkspaceMutation(ctx, call, request.Payload, provider.Move)
	case "delete":
		value, err = invokeWorkspaceMutation(ctx, call, request.Payload, provider.Delete)
	case "mkdir":
		value, err = invokeWorkspaceMutation(ctx, call, request.Payload, provider.Mkdir)
	case "access":
		value, err = invokeWorkspaceMutation(ctx, call, request.Payload, provider.Access)
	default:
		return workspaceFailure("notImplemented"), nil
	}
	if ctx.Err() != nil {
		return workspaceFailure("internal"), nil
	}
	if err != nil {
		var failure *AhpWorkspaceError
		if errors.As(err, &failure) {
			switch failure.Code {
			case "invalidParams", "permissionDenied", "notFound", "alreadyExists", "conflict", "notImplemented", "internal":
				return workspaceFailure(string(failure.Code)), nil
			}
		}
		return workspaceFailure("internal"), nil
	}
	encoded, err := json.Marshal(value)
	if err != nil || string(encoded) == "null" {
		return workspaceFailure("internal"), nil
	}
	return &rpc.HostWorkspaceExecuteResult{Payload: string(encoded)}, nil
}
