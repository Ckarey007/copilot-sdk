/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from: api.schema.json

package com.github.copilot.generated.rpc;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.github.copilot.CopilotExperimental;
import javax.annotation.processing.Generated;

/**
 * GitHub Mission Control registration options. The compute ID is application-owned and stable.
 *
 * @apiNote This type is experimental and may change in a future version.
 *
 * @since 1.0.0
 */
@CopilotExperimental
@javax.annotation.processing.Generated("copilot-sdk-codegen")
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record HostGitHubEnvironmentOptions(
    /** Human-readable environment display name. */
    @JsonProperty("name") String name,
    /** Stable application installation identity, reused across host restarts. */
    @JsonProperty("computeId") String computeId,
    /** Registration kind. Defaults to user-local; managed kinds adopt the preallocated environment identified by the authenticated owner and computeId. */
    @JsonProperty("kind") HostEnvironmentKind kind,
    /** Opaque SDK registration for a refreshable hosting credential. Tokens are requested only from the owning SDK connection through gitHubToken.getToken. A supplied lifetime must be at least 120 seconds; omission explicitly means unknown lifetime with bounded periodic refresh. Omitting this registration uses the runtime's existing authentication. */
    @JsonProperty("credentialProviderRegistrationId") String credentialProviderRegistrationId,
    /** Runtime authentication principal, independent of Mission Control's routing owner. Defaults to user. github-app requires a separately built managed-hosting runtime and a managed-sandbox registration; ordinary runtime builds reject it. */
    @JsonProperty("runtimePrincipal") HostRuntimePrincipal runtimePrincipal,
    /** Require sealed, connection-bound authentication (default true), independent of listener address. False permits unsealed direct credentials and unbound sealed relay credentials; use only when the caller fully controls and trusts the direct transport. Relay token encryption remains mandatory. */
    @JsonProperty("requireConnectionBinding") Boolean requireConnectionBinding
) {

    /**
     * Creates environment options using the default connection-binding policy.
     *
     * @param name Human-readable environment display name.
     * @param computeId Stable application installation identity, reused across host restarts.
     */
    public HostGitHubEnvironmentOptions(
        String name,
        String computeId
    ) {
        this(name, computeId, null, null, null, null);
    }

    /**
     * Creates user-local environment options with the selected connection-binding policy.
     *
     * @param name Human-readable environment display name.
     * @param computeId Stable application installation identity, reused across host restarts.
     * @param requireConnectionBinding Require sealed, connection-bound authentication (default true), independent of listener address. False permits unsealed direct credentials and unbound sealed relay credentials; use only when the caller fully controls and trusts the direct transport. Relay token encryption remains mandatory.
     */
    public HostGitHubEnvironmentOptions(
        String name,
        String computeId,
        Boolean requireConnectionBinding
    ) {
        this(name, computeId, null, null, null, requireConnectionBinding);
    }
}
