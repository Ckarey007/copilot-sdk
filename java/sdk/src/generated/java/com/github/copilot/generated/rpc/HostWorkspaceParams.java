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
 * A supervised child's request. The runtime supplies host identity rather than accepting it from the child.
 *
 * @apiNote This method is experimental and may change in a future version.
 * @since 1.0.0
 */
@CopilotExperimental
@javax.annotation.processing.Generated("copilot-sdk-codegen")
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
record HostWorkspaceParams(
    /** Selects the workspace/AHP parameter and result shapes carried by the serialized payload. */
    @JsonProperty("operation") HostWorkspaceOperation operation,
    /** Serialized operation parameters preserve AHP integer offsets and opaque etags without an untyped numeric projection. */
    @JsonProperty("payload") String payload
) {
}
