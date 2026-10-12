/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from: api.schema.json

package com.github.copilot.generated.rpc;

import com.github.copilot.CopilotExperimental;
import javax.annotation.processing.Generated;

/**
 * The closed operation set for host-scoped remote workspace IO. Watchers and process/Git execution are intentionally absent.
 *
 * @apiNote This type is experimental and may change in a future version.
 *
 * @since 1.0.0
 */
@CopilotExperimental
@javax.annotation.processing.Generated("copilot-sdk-codegen")
public enum HostWorkspaceOperation {
    /** The {@code describe} variant. */
    DESCRIBE("describe"),
    /** The {@code resolve} variant. */
    RESOLVE("resolve"),
    /** The {@code read} variant. */
    READ("read"),
    /** The {@code write} variant. */
    WRITE("write"),
    /** The {@code stat} variant. */
    STAT("stat"),
    /** The {@code list} variant. */
    LIST("list"),
    /** The {@code copy} variant. */
    COPY("copy"),
    /** The {@code move} variant. */
    MOVE("move"),
    /** The {@code delete} variant. */
    DELETE("delete"),
    /** The {@code mkdir} variant. */
    MKDIR("mkdir"),
    /** The {@code access} variant. */
    ACCESS("access");

    private final String value;
    HostWorkspaceOperation(String value) { this.value = value; }
    @com.fasterxml.jackson.annotation.JsonValue
    public String getValue() { return value; }
    @com.fasterxml.jackson.annotation.JsonCreator
    public static HostWorkspaceOperation fromValue(String value) {
        for (HostWorkspaceOperation v : values()) {
            if (v.value.equals(value)) return v;
        }
        throw new IllegalArgumentException("Unknown HostWorkspaceOperation value: " + value);
    }
}
