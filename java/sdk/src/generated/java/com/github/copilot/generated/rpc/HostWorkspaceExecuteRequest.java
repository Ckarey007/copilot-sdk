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
 * A bounded callback to the SDK connection that owns this host, including before any session exists.
 *
 * @apiNote This type is experimental and may change in a future version.
 *
 * @since 1.0.0
 */
@CopilotExperimental
@javax.annotation.processing.Generated("copilot-sdk-codegen")
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record HostWorkspaceExecuteRequest(
    /** Runtime-assigned host identity bound to this SDK connection; never supplied by a workspace client. */
    @JsonProperty("hostId") String hostId,
    /** Unique callback invocation identity; original AHP metadata remains inside the payload. */
    @JsonProperty("requestId") String requestId,
    /** Selects the workspace/AHP parameter and result shapes carried by the serialized payload. */
    @JsonProperty("operation") HostWorkspaceOperation operation,
    /** Serialized parameters and physical path guards, preserving integer offsets and opaque metadata. */
    @JsonProperty("payload") String payload
) {
}
