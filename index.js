const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const uri = process.env.MONGO_URL;

const serviceAccount = require("./decor-nest-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ================= AUTH =================
const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).send({ message: "unauthorized access!" });
    }

    try {
        const idToken = token.split(" ")[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        req.decoded_email = decoded.email;
        next();
    } catch {
        return res.status(401).send({ message: "unauthorized access!" });
    }
};

// ================= DB =================
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function run() {
    try {
        await client.connect();

        const db = client.db("decor-nest");

        const usersCollection = db.collection("users");
        const bookingsCollection = db.collection("bookings");
        const paymentsCollection = db.collection("payments");
        const decoratorsCollection = db.collection("decorators");

        // ================= USERS =================
        app.post("/users", async (req, res) => {
            const user = req.body;

            const exists = await usersCollection.findOne({ email: user.email });

            if (exists) {
                return res.send({ success: true, message: "User exists" });
            }

            user.role = "user";
            user.createdAt = new Date();

            const result = await usersCollection.insertOne(user);

            res.send({ success: true, insertedId: result.insertedId });
        });

        app.get("/users", async (req, res) => {
            const search = req.query.searchText;

            const query = search
                ? {
                    $or: [
                        { displayName: { $regex: search, $options: "i" } },
                        { email: { $regex: search, $options: "i" } },
                    ],
                }
                : {};

            const result = await usersCollection.find(query).toArray();
            res.send(result);
        });

        app.get("/users/:email/role", async (req, res) => {
            console.log("ROLE ROUTE HIT");
            console.log(req.params.email);

            const email = req.params.email;

            const user = await usersCollection.findOne({ email });

            if (!user) {
                return res.status(404).send({ role: "user" });
            }

            res.send({ role: user.role || "user" });
        });

        // ================= BOOKINGS =================
        app.get("/bookings", async (req, res) => {
            const { email, bookingStatus } = req.query;

            const query = {};
            if (email) query.userEmail = email;
            if (bookingStatus) query.bookingStatus = bookingStatus;

            const result = await bookingsCollection
                .find(query)
                .sort({ createdAt: -1 })
                .toArray();

            res.send(result);
        });

        app.post("/bookings", async (req, res) => {
            const booking = req.body;

            booking.createdAt = new Date();
            booking.bookingStatus = "pending";
            booking.paymentStatus = "unpaid";

            const result = await bookingsCollection.insertOne(booking);

            res.send(result);
        });

        // ================= ASSIGN DECORATOR (MAIN FIXED) =================
        app.patch("/bookings/:id/assign-decorator", async (req, res) => {
            try {
                const { id } = req.params;
                const { decoratorId, decoratorName, decoratorEmail } = req.body;

                // 1. check decorator availability
                const decorator = await decoratorsCollection.findOne({
                    _id: new ObjectId(decoratorId),
                });

                if (!decorator || decorator.workStatus !== "available") {
                    return res.send({
                        success: false,
                        message: "Decorator not available",
                    });
                }

                // 2. update booking
                await bookingsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            decoratorId,
                            decoratorName,
                            decoratorEmail,
                            bookingStatus: "decorator_assigned",
                        },
                    }
                );

                // 3. mark decorator busy
                await decoratorsCollection.updateOne(
                    { _id: new ObjectId(decoratorId) },
                    {
                        $set: {
                            workStatus: "busy",
                        },
                    }
                );

                res.send({ success: true });

            } catch (error) {
                res.status(500).send({ success: false });
            }
        });

        // ================= COMPLETE BOOKING =================
        app.patch("/bookings/:id/complete", async (req, res) => {
            try {
                const { id } = req.params;
                const { decoratorId } = req.body;

                // 1. complete booking
                await bookingsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            bookingStatus: "completed",
                        },
                    }
                );

                // 2. decorator free again
                await decoratorsCollection.updateOne(
                    { _id: new ObjectId(decoratorId) },
                    {
                        $set: {
                            workStatus: "available",
                        },
                    }
                );

                res.send({ success: true });

            } catch (error) {
                res.status(500).send({ success: false });
            }
        });

        // ================= DECORATORS =================
        app.get('/decorators', async (req, res) => {
            const { status, workStatus, district, region } = req.query;

            const query = {};

            if (status) query.status = status;
            if (workStatus) query.workStatus = workStatus;
            if (district) query.district = district;
            if (region) query.region = region;

            const result = await decoratorsCollection.find(query).toArray();
            res.send(result);
        });

        app.post("/decorators", async (req, res) => {
            const decorator = req.body;

            const newDecorator = {
                ...decorator,
                status: "pending",
                role: "decorator",
                workStatus: "inactive",
                createdAt: new Date(),
            };

            const result = await decoratorsCollection.insertOne(newDecorator);

            res.send(result);
        });

        // APPROVE / REJECT DECORATOR
        app.patch("/decorators/:id", async (req, res) => {
            try {
                const { id } = req.params;
                const { status, email } = req.body;

                await decoratorsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            status,
                            workStatus: status === "approved" ? "available" : "inactive",
                        },
                    }
                );

                if (status === "approved") {
                    await usersCollection.updateOne(
                        { email },
                        { $set: { role: "decorator" } }
                    );
                }

                res.send({ success: true });
            } catch (err) {
                res.status(500).send({ success: false });
            }
        });

        app.delete("/decorators/:id", async (req, res) => {
            const id = req.params.id;

            const result = await decoratorsCollection.deleteOne({
                _id: new ObjectId(id),
            });

            res.send(result);
        });

        // ================= PAYMENTS =================
        app.get("/payments", async (req, res) => {
            const { email } = req.query;

            const query = email ? { customerEmail: email } : {};

            const result = await paymentsCollection
                .find(query)
                .sort({ paidAt: -1 })
                .toArray();

            res.send(result);
        });

        app.post("/create-checkout-session", async (req, res) => {
            try {
                const paymentInfo = req.body;

                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ["card"],
                    line_items: [
                        {
                            price_data: {
                                currency: "usd",
                                product_data: {
                                    name: paymentInfo.serviceName,
                                },
                                unit_amount: parseInt(paymentInfo.amount * 100),
                            },
                            quantity: 1,
                        },
                    ],
                    mode: "payment",
                    customer_email: paymentInfo.customerEmail,
                    metadata: {
                        bookingId: paymentInfo.bookingId,
                        serviceName: paymentInfo.serviceName,
                    },
                    success_url: `${process.env.CLIENT_URL}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.CLIENT_URL}/dashboard/my-bookings`,
                });

                res.send({ url: session.url });
            } catch {
                res.status(500).send({ message: "Stripe failed" });
            }
        });

        app.patch("/payment-success", async (req, res) => {
            try {
                const sessionId = req.query.session_id;

                const session = await stripe.checkout.sessions.retrieve(sessionId);

                const transactionId = session.payment_intent;

                const exists = await paymentsCollection.findOne({ transactionId });

                if (exists) {
                    return res.send({ success: true, message: "already paid" });
                }

                if (session.payment_status === "paid") {
                    const bookingId = session.metadata.bookingId;

                    await bookingsCollection.updateOne(
                        { _id: new ObjectId(bookingId) },
                        {
                            $set: {
                                paymentStatus: "paid",
                                bookingStatus: "confirmed",
                            },
                        }
                    );

                    const paymentDoc = {
                        bookingId,
                        transactionId,
                        serviceName: session.metadata.serviceName,
                        amount: session.amount_total / 100,
                        customerEmail: session.customer_email,
                        paidAt: new Date(),
                    };

                    await paymentsCollection.insertOne(paymentDoc);

                    return res.send({ success: true, payment: paymentDoc });
                }

                res.send({ success: false });
            } catch {
                res.status(500).send({ message: "payment failed" });
            }
        });

        // ================= HEALTH CHECK =================
        app.get("/", (req, res) => {
            res.send("Decor Nest API Running 🚀");
        });

        await client.db("admin").command({ ping: 1 });

        console.log("MongoDB Connected 🚀");
    } finally {
        // keep alive
    }
}

run().catch(console.dir);

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});