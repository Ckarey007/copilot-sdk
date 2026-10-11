/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from: api.schema.json

package com.github.copilot.generated.rpc;

import com.github.copilot.CopilotExperimental;
import javax.annotation.processing.Generated;

/**
 * Compute kinds supported by attached environment registration.
 *
 * @apiNote This type is experimental and may change in a future version.
 *
 * @since 1.0.0
 */
@CopilotExperimental
@javax.annotation.processing.Generated("copilot-sdk-codegen")
public enum HostEnvironmentKind {
    /** The {@code user-local} variant. */
    USER_LOCAL("user-local"),
    /** The {@code managed-sandbox} variant. */
    MANAGED_SANDBOX("managed-sandbox"),
    /** The {@code managed-cca} variant. */
    MANAGED_CCA("managed-cca");

    private final String value;
    HostEnvironmentKind(String value) { this.value = value; }
    @com.fasterxml.jackson.annotation.JsonValue
    public String getValue() { return value; }
    @com.fasterxml.jackson.annotation.JsonCreator
    public static HostEnvironmentKind fromValue(String value) {
        for (HostEnvironmentKind v : values()) {
            if (v.value.equals(value)) return v;
        }
        throw new IllegalArgumentException("Unknown HostEnvironmentKind value: " + value);
    }
}
