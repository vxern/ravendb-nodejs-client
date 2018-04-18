import * as mocha from "mocha";
import * as BluebirdPromise from "bluebird";
import * as assert from "assert";
import { RemoteTestContext, globalContext, disposeTestDocumentStore } from "../Utils/TestUtil";

import {
    TypesAwareObjectMapper, 
    IRavenObject, 
    ObjectTypeDescriptor, 
    ClassConstructor, 
    ObjectLiteralDescriptor, 
    PropsBasedObjectLiteralDescriptor    
} from "../../src";
import { DateUtil } from "../../src/Utility/DateUtil";
import { TypeInfo } from "../../src/Mapping/ObjectMapper";

describe.only("ObjectMapper", function () {

    let mapper: TypesAwareObjectMapper;

    beforeEach(() => {
        mapper = new TypesAwareObjectMapper({
            dateFormat: DateUtil.DEFAULT_DATE_FORMAT
        });
    });

    class Person {
        constructor(public name: string) { }

        public sayHello() {
            return `Hello, I'm ${this.name}.`;
        }
    }

    class Movie {
        constructor(
            public name: string,
            public releasedAt: Date
        ) { }
    }

    interface IAnimal {
        name: string;
        legsCount: number;
        run();
    }

    class AnimalTypeDescriptor extends PropsBasedObjectLiteralDescriptor<IAnimal> {

        public name = "Animal";
        public properties = ["name", "legsCount"];

        public construct(dto: object): IAnimal {
            return Object.assign({} as IAnimal, dto, {
                run() {
                    return `Running ${this.name} on ${this.legsCount} legs.`;
                }
            });
        }
        }


    describe("fromObjectLiteral()", function () {

        it("can handle Date type", () => {
            const typeInfo = {
                nestedTypes: {
                    bornAt: "date" 
                }
            };

            const result: IRavenObject = mapper.fromObjectLiteral(
                { bornAt: "1998-05-06T00:00:00.0000000" }, typeInfo);
            assert.ok(result);
            assert.ok(result.hasOwnProperty("bornAt"));

            const bornAt: Date = result.bornAt;
            assert.ok(bornAt instanceof Date);
            assert.ok(typeof bornAt.getMonth === "function");
            assert.equal(bornAt.getFullYear(), 1998);
            assert.equal(bornAt.getDate(), 6);
            assert.equal(bornAt.getMonth(), 4);
        });

        it("can handle array", () => {
            const typeInfo = {
                nestedTypes: {
                    "dates[]": "date"
                }
            };

            const result: IRavenObject = mapper.fromObjectLiteral({
                dates: [
                    "1998-05-06T00:00:00.0000000",
                    "1998-05-06T00:00:00.0000000",
                    "1998-05-06T00:00:00.0000000"
                ]
            }, typeInfo);

            assert.ok(result);
            assert.ok(result.hasOwnProperty("dates"));

            const dates: Date[] = result.dates;
            assert.equal(3, dates.length);
            for (const d of dates) {
                assert.ok(typeof d !== "string");
                assert.ok(d instanceof Date);
                assert.ok(typeof d.getMonth === "function");
                assert.equal(d.getFullYear(), 1998);
                assert.equal(d.getDate(), 6);
                assert.equal(d.getMonth(), 4);
            }
        });

        it("can handle top-level ctor", () => {
            const typeInfo = {
                typeName: Person.name
            };

            const result: any = mapper.fromObjectLiteral({
                name: "Merry"
            }, typeInfo, new Map([[Person.name, Person]]));

            assert.ok(result);
            assert.equal(result.constructor.name, Person.name);
            assert.equal(result.constructor, Person);
            assert.equal(result.name, "Merry");
            assert.equal(result.sayHello(), "Hello, I'm Merry.");
        });

        it("can handle properties of objects in array", () => {
            const typeInfo = {
                nestedTypes: {
                    "movies[]": Movie.name,
                    "movies[].releasedAt": "date"
                }
            };

            const testObject = {
                movies: [
                    {
                        name: "Matrix",
                        releasedAt: "1999-06-06T00:00:00.0000000"
                    },
                    {
                        name: "Titanic",
                        releasedAt: "1998-07-07T00:00:00.0000000"
                    }
                ]
            };

            const result: any = mapper.fromObjectLiteral(
                testObject, typeInfo, new Map([[Movie.name, Movie]]));

            assert.ok(result);
            assert.ok(result.hasOwnProperty("movies"));
            assert.equal(result.movies.length, 2);
            assert.equal(result.movies[0].name, "Matrix");
            assert.equal(result.movies[1].name, "Titanic");

            for (const movie of result.movies) {
                const releasedAt = movie.releasedAt;
                assert.ok(releasedAt);
                assert.ok(typeof releasedAt !== "string");
                assert.equal(typeof releasedAt.getFullYear, "function");
                assert.ok(releasedAt.getFullYear());
            }
        });

        it("can handle ctor", () => {
            const testObject = {
                me: { name: "Greg", bornAt: "1987-10-12T00:00:00.0000000" },
                people: [
                    { name: "John" },
                    { name: "Samantha" }
                ]
            };

            const typeInfo: TypeInfo = {
                nestedTypes: {
                    "me": "Person", 
                    "me.bornAt": "date",
                    "people[]": "Person"    
                }
            };
            const types = new Map<string, ObjectTypeDescriptor>([
                [ "Person", Person ]
            ]);
            const result: any = mapper.fromObjectLiteral(testObject, typeInfo, types);

            assert.ok(result);
            assert.ok(result.me);
            assert.equal(result.me.constructor.name, Person.name);
            assert.equal(result.me.name, "Greg");
            assert.equal(typeof result.me.sayHello, "function");
            assert.equal(result.me.sayHello(), "Hello, I'm Greg.");
            assert.equal(result.me.bornAt.getFullYear(), 1987);

            assert.equal(result.people[0].constructor.name, Person.name);
            assert.equal(result.people[0].name, "John");
            assert.equal(result.people[0].sayHello(), "Hello, I'm John.");

            assert.equal(result.people[1].name, "Samantha");
            assert.equal(result.people[1].sayHello(), "Hello, I'm Samantha.");
        });

        it("can handle dot operator", () => {
            const data = { 
                person: {
                    bornAt: "1987-10-12T00:00:00.0000000" 
                }                
            };

            const typeInfo = {
                nestedTypes: {
                    "person.bornAt": "date"
                }
            };

            const result: any = mapper.fromObjectLiteral(data, typeInfo);
            assert.ok(result);
            assert.ok(result.person);
            assert.ok(result.person.bornAt);
            assert.equal(typeof result.person.bornAt, "object");
            assert.ok(result.person.bornAt.getFullYear);
            assert.equal(result.person.bornAt.getFullYear(), 1987);
        });

        it("can handle object literal descriptor", () => {
            const data = {
                animals: [
                    {
                        name: "Giraffe",
                        legsCount: 4
                    }
                ]
            };

            const typeInfo = {
                nestedTypes: {
                    "animals[]": "Animal"
                }
            };

            const typeDescriptorInstance = new AnimalTypeDescriptor();
            const types = new Map([[typeDescriptorInstance.name, typeDescriptorInstance]]);
            const result: any = mapper.fromObjectLiteral(
                data, typeInfo, types);
            assert.ok(result);
            assert.ok(result.animals);
            assert.ok(result.animals.length);

            const animal = result.animals[0];
            assert.equal(animal.name, "Giraffe");
            assert.equal(animal.legsCount, 4);
            assert.equal(animal.run(), "Running Giraffe on 4 legs.");
        });

        it("can handle array of arrays", () => {
            const typeInfo = {
                nestedTypes: {
                    "characters[][]": "Person",
                    "characters[][].lastActedAt": "date"
                }
            };

            const data = {
                characters: [
                    [ 
                        { 
                            name: "Jon", 
                            lastActedAt: "2017-10-12T00:00:00.0000000" 
                        }, 
                        { 
                            name: "Bran",
                            lastActedAt: "2017-10-12T00:00:00.0000000" 
                        }
                    ],
                    [
                        { 
                            name: "Jaime",
                            lastActedAt: "2017-10-12T00:00:00.0000000" 
                        }, 
                        { 
                            name: "Tyrion",
                            lastActedAt: "2017-10-12T00:00:00.0000000" 
                        }, 
                        { 
                            name: "Cersei",
                            lastActedAt: "2017-10-12T00:00:00.0000000" 
                        }
                    ]
                ]
            };

            const result: any = mapper.fromObjectLiteral(
                data, typeInfo, new Map([[Person.name, Person]]));

            assert.ok(result);
            assert.ok(result.characters);
            assert.ok(result.characters.length);

            assert.ok(result.characters[0]);
            assert.equal(result.characters[0].length, 2);
            assert.deepEqual(result.characters[0], data.characters[0]);


            for (let i = 0; i < result.characters[0].length; i++) {
                const c = result.characters[0][i];
                assert.equal(typeof c.constructor, "function");
                assert.equal(c.constructor, Person);
                assert.equal(c.sayHello(), `Hello, I'm ${data.characters[0][i].name}.`);
                assert.equal(typeof c.lastActedAt.getMonth, "function");
            }

            assert.ok(result.characters[1].length);
            assert.equal(result.characters[1].length, 3);
            assert.deepEqual(result.characters[1], data.characters[1]);
        });

        xit("can handle complex objects with nested class instances, arrays and dates", () => {
            throw new Error("Not implemented yet");
        });

    });

    describe("toObjectLiteral()", function () {
        let typeInfo;
        let typeInfoCallback;

        beforeEach(() => {
            typeInfo = null;
            typeInfoCallback = (_typeInfo) => typeInfo = _typeInfo;
        });

        it("can handle Date type", () => {

            const testObject = {
                lastModified: new Date(2018, 2, 14)
            };
            const result: any = mapper.toObjectLiteral(testObject, typeInfoCallback); 
            const expectedTypeInfo = {
                nestedTypes: {
                    lastModified: "date"
                }
            };

            assert.deepEqual(typeInfo, expectedTypeInfo);
            assert.equal(typeof result.lastModified, "string");
            assert.equal(result.lastModified, DateUtil.stringify(testObject.lastModified));
        });

        it("can handle array", () => {
            const testObject = {
                dates: [
                    new Date(2012, 10, 1),
                    new Date(2013, 2, 1)
                ]
            };
            const result: any = mapper.toObjectLiteral(testObject, typeInfoCallback); 
            const expectedTypeInfo = {
                nestedTypes: {
                    "dates[]": "date"
                }
            };
            assert.deepEqual(typeInfo, expectedTypeInfo);
            assert.equal(typeof result.dates[0], "string");
            assert.equal(result.dates[0], "2012-11-01T00:00:00.0000000");
            assert.equal(result.dates.length, 2);
        });

        it("can handle top-level ctor", () => {
            const testObject = new Person("Maynard");
            const result: any = mapper.toObjectLiteral(testObject, typeInfoCallback);

            assert.ok(testObject !== result);
            assert.ok(!result.hasOwnProperty("sayHello"));
            assert.ok(typeInfo.typeName, Person.name);
            assert.ok(!typeInfo.hasOwnProperty("nestedTypes"));
        });

        it("can handle properties of objects in array", () => {

            const testObject = {
                movies: [
                    new Movie("Matrix", new Date(1999, 5, 6)),
                    new Movie("Titanic", new Date(1998, 6, 7))
                ]
            };

            const types = new Map([[Movie.name, Movie]]);
            const result: any = mapper.toObjectLiteral(testObject, typeInfoCallback, types);

            const expectedTypeInfo = {
                nestedTypes: {
                    "movies[]": Movie.name,
                    "movies[].releasedAt": "date"
                }
            };

            assert.deepEqual(expectedTypeInfo, typeInfo);
            assert.ok(testObject !== result);
            assert.equal(result.movies.length, 2);
            assert.equal(result.movies[0].constructor, Object);
            assert.equal(typeof result.movies[0].releasedAt, "string");
            assert.equal(result.movies[0].releasedAt, "1999-06-06T00:00:00.0000000");
        });

        it("can handle ctor for property and arrays", () => {
            const testObject = {
                me: Object.assign(new Person("Greg"), { bornAt: new Date(1987, 9, 12) }),
                people: [
                    new Person("John"),
                    new Person("Samantha")
                ]
            };

            const types = new Map([[ Person.name, Person ]]);
            const result: any = mapper.toObjectLiteral(testObject, typeInfoCallback, types);

            const expectedTypeInfo: TypeInfo = {
                nestedTypes: {
                    "me": "Person", 
                    "me.bornAt": "date",
                    "people[]": "Person"    
                }
            };
            assert.deepEqual(typeInfo, expectedTypeInfo);
            assert.ok(result !== testObject);
            assert.equal(result.me.constructor, Object);
            assert.equal(result.me.bornAt, "1987-10-12T00:00:00.0000000");

            assert.equal(result.people.length, 2);
            assert.equal(result.people[0].constructor, Object);
            assert.equal(result.people[0].name, "John");
            assert.equal(result.people[1].constructor, Object);
            assert.equal(result.people[1].name, "Samantha");
        });

        it("can handle dot operator", () => {
            const data = { 
                person: {
                    bornAt: new Date(1987, 9, 12) 
                }                
            };

            const result: any = mapper.toObjectLiteral(data, typeInfoCallback);

            const expectedTypeInfo = {
                nestedTypes: {
                    "person.bornAt": "date"
                }
            };

            assert.deepEqual(typeInfo, expectedTypeInfo);
            assert.equal(result.person.bornAt, "1987-10-12T00:00:00.0000000");
        });

        it("can handle object literal descriptor", () => {
            const typeDescriptorInstance = new AnimalTypeDescriptor();
            const data = {
                animals: [
                    typeDescriptorInstance.construct({
                        name: "Giraffe",
                        legsCount: 4
                    })
                ]
            };

            const types = new Map([[typeDescriptorInstance.name, typeDescriptorInstance]]);
            const result: any = mapper.toObjectLiteral(data, typeInfoCallback, types);

            const expectedTypeInfo = {
                nestedTypes: {
                    "animals[]": typeDescriptorInstance.name
                }
            };

            assert.deepEqual(typeInfo, expectedTypeInfo);
        });

        it("can handle array of arrays", () => {
            const newCharacter = (name: string) => 
                Object.assign(new Person(name), { lastActedAt: new Date(2017, 9, 12) });
                
            const data = {
                characters: [
                    [
                        newCharacter("Jon"),
                        newCharacter("Bran")
                    ],
                    [
                        newCharacter("Jaime"),
                        newCharacter("Tyrion"),
                        newCharacter("Cersei")
                    ]
                ]
            };

            const types = new Map([[Person.name, Person]]);
            const result: any = mapper.toObjectLiteral(data, typeInfoCallback, types);

            const expectedTypeInfo = {
                nestedTypes: {
                    "characters[][]": "Person",
                    "characters[][].lastActedAt": "date"
                }
            };

            assert.deepEqual(typeInfo, expectedTypeInfo);
        });
    });
});
