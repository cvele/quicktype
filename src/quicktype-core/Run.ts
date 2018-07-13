import { mapFirst } from "collection-utils";

import * as targetLanguages from "./language/All";
import { TargetLanguage } from "./TargetLanguage";
import { SerializedRenderResult, Annotation, Location, Span } from "./Source";
import { assert } from "./support/Support";
import { combineClasses } from "./rewrites/CombineClasses";
import { inferMaps } from "./rewrites/InferMaps";
import { TypeBuilder, StringTypeMapping } from "./TypeBuilder";
import { TypeGraph, noneToAny, optionalToNullable, removeIndirectionIntersections } from "./TypeGraph";
import { initTypeNames } from "./TypeNames";
import { gatherNames } from "./GatherNames";
import { expandStrings } from "./rewrites/ExpandStrings";
import { flattenUnions } from "./rewrites/FlattenUnions";
import { resolveIntersections } from "./rewrites/ResolveIntersections";
import { replaceObjectType } from "./rewrites/ReplaceObjectType";
import { messageError } from "./Messages";
import { InputData } from "./input/Inputs";
import { flattenStrings } from "./rewrites/FlattenStrings";
import { makeTransformations } from "./MakeTransformations";

export function getTargetLanguage(nameOrInstance: string | TargetLanguage): TargetLanguage {
    if (typeof nameOrInstance === "object") {
        return nameOrInstance;
    }
    const language = targetLanguages.languageNamed(nameOrInstance);
    if (language !== undefined) {
        return language;
    }
    return messageError("DriverUnknownOutputLanguage", { lang: nameOrInstance });
}

export type RendererOptions = { [name: string]: string };

export interface InferenceFlag {
    description: string;
    negationDescription: string;
}

export const inferenceFlags = {
    /** Combine similar classes.  This doesn't apply to classes from a schema, only from inference. */
    combineClasses: { description: "Merge similar classes", negationDescription: "Don't combine similar classes" },
    /** Whether to infer map types from JSON data */
    inferMaps: { description: "Detect maps", negationDescription: "Don't infer maps, always use classes" },
    /** Whether to infer enum types from JSON data */
    inferEnums: { description: "Detect enums", negationDescription: "Don't infer enums, always use strings" },
    /** Whether to assume that JSON strings that look like dates are dates */
    inferDates: { description: "Detect dates & times", negationDescription: "Don't infer dates or times" },
    /** Whether to convert stringified integers to integers */
    inferIntegerStrings: {
        description: "Detect integers in strings",
        negationDescription: "Don't convert stringified integers to integers"
    }
};

export type InferenceFlags = { [F in keyof typeof inferenceFlags]: boolean };

/**
 * The options type for the main quicktype entry points,
 * `quicktypeMultiFile` and `quicktype`.
 */
export type Options = InferenceFlags & {
    /**
     * The target language for which to produce code.  This can be either an instance of `TargetLanguage`,
     * or a string specifying one of the names for quicktype's built-in target languages.  For example,
     * both `cs` and `csharp` will generate C#.
     */
    lang: string | TargetLanguage;
    /** The input data from which to produce types */
    inputData: InputData;
    /** Put class properties in alphabetical order, instead of in the order found in the JSON */
    alphabetizeProperties: boolean;
    /** Make all class property optional */
    allPropertiesOptional: boolean;
    /**
     * Make top-levels classes from JSON fixed.  That means even if two top-level classes are exactly
     * the same, quicktype will still generate two separate types for them.
     */
    fixedTopLevels: boolean;
    /** Don't render output.  This is mainly useful for benchmarking. */
    noRender: boolean;
    /** If given, output these comments at the beginning of the main output file */
    leadingComments: string[] | undefined;
    /** Options for the target language's renderer */
    rendererOptions: RendererOptions;
    /** String to use for one indentation level.  If not given, use the target language's default. */
    indentation: string | undefined;
    /** Name of the output file.  Note that quicktype will not write that file, but you'll get its name
     * back as a key in the resulting `Map`.
     */
    outputFilename: string;
    /** Print the type graph to the console at every processing step */
    debugPrintGraph: boolean;
    /** Check that we're propagating all type attributes (unless we actually can't) */
    checkProvenance: boolean;
    /**
     * Print type reconstitution debug information to the console.  You'll only ever need this if
     * you're working deep inside quicktype-core.
     */
    debugPrintReconstitution: boolean;
    /**
     * Print name gathering debug information to the console.  This might help to figure out why
     * your types get weird names, but the output is quite arcane.
     */
    debugPrintGatherNames: boolean;
    /** Print all transformations to the console prior to generating code */
    debugPrintTransformations: boolean;
    /** Print the time it took for each pass to run */
    debugPrintTimes: boolean;
};

const defaultOptions: Options = {
    lang: "ts",
    inputData: new InputData(),
    combineClasses: true,
    alphabetizeProperties: false,
    allPropertiesOptional: false,
    fixedTopLevels: false,
    noRender: false,
    leadingComments: undefined,
    rendererOptions: {},
    indentation: undefined,
    outputFilename: "stdout",
    debugPrintGraph: false,
    checkProvenance: false,
    debugPrintReconstitution: false,
    debugPrintGatherNames: false,
    debugPrintTransformations: false,
    debugPrintTimes: false,

    inferMaps: true,
    inferEnums: true,
    inferDates: true,
    inferIntegerStrings: true
};

export interface RunContext {
    stringTypeMapping: StringTypeMapping;
    debugPrintReconstitution: boolean;
    debugPrintTransformations: boolean;

    timeSync<T>(name: string, f: () => Promise<T>): Promise<T>;
    time<T>(name: string, f: () => T): T;
}

class Run implements RunContext {
    private readonly _options: Options;

    constructor(options: Partial<Options>) {
        // We must not overwrite defaults with undefined values, which
        // we sometimes get.
        this._options = Object.assign({}, defaultOptions);
        for (const k of Object.getOwnPropertyNames(options)) {
            const v = (options as any)[k];
            if (v !== undefined) {
                (this._options as any)[k] = v;
            }
        }
    }

    get stringTypeMapping(): StringTypeMapping {
        const targetLanguage = getTargetLanguage(this._options.lang);
        return targetLanguage.stringTypeMapping;
    }

    get debugPrintReconstitution(): boolean {
        return this._options.debugPrintReconstitution === true;
    }

    get debugPrintTransformations(): boolean {
        return this._options.debugPrintTransformations;
    }

    async timeSync<T>(name: string, f: () => Promise<T>): Promise<T> {
        const start = Date.now();
        const result = await f();
        const end = Date.now();
        if (this._options.debugPrintTimes) {
            console.log(`${name} took ${end - start}ms`);
        }
        return result;
    }

    time<T>(name: string, f: () => T): T {
        const start = Date.now();
        const result = f();
        const end = Date.now();
        if (this._options.debugPrintTimes) {
            console.log(`${name} took ${end - start}ms`);
        }
        return result;
    }

    private async makeGraph(allInputs: InputData): Promise<TypeGraph> {
        const targetLanguage = getTargetLanguage(this._options.lang);
        const stringTypeMapping = this.stringTypeMapping;
        const conflateNumbers = !targetLanguage.supportsUnionsWithBothNumberTypes;
        const typeBuilder = new TypeBuilder(
            0,
            stringTypeMapping,
            this._options.alphabetizeProperties,
            this._options.allPropertiesOptional,
            this._options.checkProvenance,
            false
        );

        await this.timeSync(
            "read input",
            async () =>
                await allInputs.addTypes(
                    typeBuilder,
                    this._options.inferMaps,
                    this._options.inferEnums,
                    this._options.inferDates,
                    this._options.inferIntegerStrings,
                    this._options.fixedTopLevels
                )
        );

        let graph = typeBuilder.finish();
        if (this._options.debugPrintGraph) {
            graph.setPrintOnRewrite();
            graph.printGraph();
        }

        const debugPrintReconstitution = this.debugPrintReconstitution;

        if (typeBuilder.didAddForwardingIntersection) {
            this.time(
                "remove indirection intersections",
                () => (graph = removeIndirectionIntersections(graph, stringTypeMapping, debugPrintReconstitution))
            );
        }

        let unionsDone = false;
        if (allInputs.needSchemaProcessing) {
            let intersectionsDone = false;
            do {
                const graphBeforeRewrites = graph;
                if (!intersectionsDone) {
                    this.time(
                        "resolve intersections",
                        () =>
                            ([graph, intersectionsDone] = resolveIntersections(
                                graph,
                                stringTypeMapping,
                                debugPrintReconstitution
                            ))
                    );
                }
                if (!unionsDone) {
                    this.time(
                        "flatten unions",
                        () =>
                            ([graph, unionsDone] = flattenUnions(
                                graph,
                                stringTypeMapping,
                                conflateNumbers,
                                true,
                                debugPrintReconstitution
                            ))
                    );
                }

                if (graph === graphBeforeRewrites) {
                    assert(intersectionsDone && unionsDone, "Graph didn't change but we're not done");
                }
            } while (!intersectionsDone || !unionsDone);
        }

        this.time(
            "replace object type",
            () =>
                (graph = replaceObjectType(
                    graph,
                    stringTypeMapping,
                    conflateNumbers,
                    targetLanguage.supportsFullObjectType,
                    debugPrintReconstitution
                ))
        );
        do {
            this.time(
                "flatten unions",
                () =>
                    ([graph, unionsDone] = flattenUnions(
                        graph,
                        stringTypeMapping,
                        conflateNumbers,
                        false,
                        debugPrintReconstitution
                    ))
            );
        } while (!unionsDone);

        if (this._options.combineClasses) {
            const combinedGraph = this.time("combine classes", () =>
                combineClasses(this, graph, this._options.alphabetizeProperties, true, false, debugPrintReconstitution)
            );
            if (combinedGraph === graph) {
                graph = combinedGraph;
            } else {
                this.time(
                    "combine classes cleanup",
                    () =>
                        (graph = combineClasses(
                            this,
                            combinedGraph,
                            this._options.alphabetizeProperties,
                            false,
                            true,
                            debugPrintReconstitution
                        ))
                );
            }
        }

        if (this._options.inferMaps) {
            for (;;) {
                const newGraph = this.time("infer maps", () =>
                    inferMaps(graph, stringTypeMapping, true, debugPrintReconstitution)
                );
                if (newGraph === graph) {
                    break;
                }
                graph = newGraph;
            }
        }

        const enumInference = allInputs.needSchemaProcessing ? "all" : this._options.inferEnums ? "infer" : "none";
        this.time("expand strings", () => (graph = expandStrings(this, graph, enumInference)));
        this.time(
            "flatten unions",
            () =>
                ([graph, unionsDone] = flattenUnions(
                    graph,
                    stringTypeMapping,
                    conflateNumbers,
                    false,
                    debugPrintReconstitution
                ))
        );
        assert(unionsDone, "We should only have to flatten unions once after expanding strings");

        if (allInputs.needSchemaProcessing) {
            this.time(
                "flatten strings",
                () => (graph = flattenStrings(graph, stringTypeMapping, debugPrintReconstitution))
            );
        }

        this.time("none to any", () => (graph = noneToAny(graph, stringTypeMapping, debugPrintReconstitution)));
        if (!targetLanguage.supportsOptionalClassProperties) {
            this.time(
                "optional to nullable",
                () => (graph = optionalToNullable(graph, stringTypeMapping, debugPrintReconstitution))
            );
        }

        this.time("fixed point", () => (graph = graph.rewriteFixedPoint(false, debugPrintReconstitution)));

        this.time("make transformations", () => (graph = makeTransformations(this, graph, targetLanguage)));

        this.time(
            "flatten unions",
            () =>
                ([graph, unionsDone] = flattenUnions(
                    graph,
                    stringTypeMapping,
                    conflateNumbers,
                    false,
                    debugPrintReconstitution
                ))
        );
        assert(unionsDone, "We should only have to flatten unions once after making transformations");

        // Sometimes we combine classes in ways that will the order come out
        // differently compared to what it would be from the equivalent schema,
        // so we always just garbage collect to get a defined order and be done
        // with it.
        // FIXME: We don't actually have to do this if any of the above graph
        // rewrites did anything.  We could just check whether the current graph
        // is different from the one we started out with.
        this.time(
            "GC",
            () => (graph = graph.garbageCollect(this._options.alphabetizeProperties, debugPrintReconstitution))
        );

        if (this._options.debugPrintGraph) {
            console.log("\n# gather names");
        }
        this.time("gather names", () =>
            gatherNames(graph, !allInputs.needSchemaProcessing, this._options.debugPrintGatherNames)
        );
        if (this._options.debugPrintGraph) {
            graph.printGraph();
        }

        return graph;
    }

    private makeSimpleTextResult(lines: string[]): ReadonlyMap<string, SerializedRenderResult> {
        return new Map([[this._options.outputFilename, { lines, annotations: [] }]] as [
            string,
            SerializedRenderResult
        ][]);
    }

    public async run(): Promise<ReadonlyMap<string, SerializedRenderResult>> {
        // FIXME: This makes quicktype not quite reentrant
        initTypeNames();

        const targetLanguage = getTargetLanguage(this._options.lang);
        const inputData = this._options.inputData;

        await inputData.finishAddingInputs();

        const needIR = inputData.needIR || targetLanguage.names.indexOf("schema") < 0;

        const schemaString = needIR ? undefined : inputData.singleStringSchemaSource();
        if (schemaString !== undefined) {
            const lines = JSON.stringify(JSON.parse(schemaString), undefined, 4).split("\n");
            lines.push("");
            const srr = { lines, annotations: [] };
            return new Map([[this._options.outputFilename, srr] as [string, SerializedRenderResult]]);
        }

        const graph = await this.makeGraph(inputData);

        if (this._options.noRender) {
            return this.makeSimpleTextResult(["Done.", ""]);
        }

        return targetLanguage.renderGraphAndSerialize(
            graph,
            this._options.outputFilename,
            this._options.alphabetizeProperties,
            this._options.leadingComments,
            this._options.rendererOptions,
            this._options.indentation
        );
    }
}

/**
 * Run quicktype and produce one or more output files.
 *
 * @param options Partial options.  For options that are not defined, the
 * defaults will be used.
 */
export async function quicktypeMultiFile(
    options: Partial<Options>
): Promise<ReadonlyMap<string, SerializedRenderResult>> {
    return await new Run(options).run();
}

function offsetLocation(loc: Location, lineOffset: number): Location {
    return { line: loc.line + lineOffset, column: loc.column };
}

function offsetSpan(span: Span, lineOffset: number): Span {
    return { start: offsetLocation(span.start, lineOffset), end: offsetLocation(span.end, lineOffset) };
}

/**
 * Run quicktype like `quicktypeMultiFile`, but if there are multiple
 * output files they will all be squashed into one output, with comments at the
 * start of each file.
 *
 * @param options Partial options.  For options that are not defined, the
 * defaults will be used.
 */
export async function quicktype(options: Partial<Options>): Promise<SerializedRenderResult> {
    const result = await quicktypeMultiFile(options);
    if (result.size <= 1) {
        const first = mapFirst(result);
        if (first === undefined) {
            return { lines: [], annotations: [] };
        }
        return first;
    }
    let lines: string[] = [];
    let annotations: Annotation[] = [];
    for (const [filename, srr] of result) {
        const offset = lines.length + 2;
        lines = lines.concat([`// ${filename}`, ""], srr.lines);
        annotations = annotations.concat(
            srr.annotations.map(ann => ({ annotation: ann.annotation, span: offsetSpan(ann.span, offset) }))
        );
    }
    return { lines, annotations };
}
