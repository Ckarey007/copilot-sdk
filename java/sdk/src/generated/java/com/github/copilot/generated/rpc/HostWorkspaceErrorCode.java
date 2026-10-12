/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from: api.schema.json

package com.github.copilot.generated.rpc;

import com.github.copilot.CopilotExperimental;
import javax.annotation.processing.Generated;

/**
 * Only these errors cross the workspace callback boundary; arbitrary provider diagnostics are not exposed.
 *
 * @apiNote This type is experimental and may change in a future version.
 *
 * @since 1.0.0
 */
@CopilotExperimental
@javax.annotation.processing.Generated("copilot-sdk-codegen")
public enum HostWorkspaceErrorCode {
    /** The {@code invalidParams} variant. */
    INVALIDPARAMS("invalidParams"),
    /** The {@code permissionDenied} variant. */
    PERMISSIONDENIED("permissionDenied"),
    /** The {@code notFound} variant. */
    NOTFOUND("notFound"),
    /** The {@code alreadyExists} variant. */
    ALREADYEXISTS("alreadyExists"),
    /** The {@code conflict} variant. */
    CONFLICT("conflict"),
    /** The {@code notImplemented} variant. */
    NOTIMPLEMENTED("notImplemented"),
    /** The {@code internal} variant. */
    INTERNAL("internal");

    private final String value;
    HostWorkspaceErrorCode(String value) { this.value = value; }
    @com.fasterxml.jackson.annotation.JsonValue
    public String getValue() { return value; }
    @com.fasterxml.jackson.annotation.JsonCreator
    public static HostWorkspaceErrorCode fromValue(String value) {
        for (HostWorkspaceErrorCode v : values()) {
            if (v.value.equals(value)) return v;
        }
        throw new IllegalArgumentException("Unknown HostWorkspaceErrorCode value: " + value);
    }
}
