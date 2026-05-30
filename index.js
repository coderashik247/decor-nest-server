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
            booking.projectStatus = "pending";

            const result = await bookingsCollection.insertOne(booking);

            res.send(result);
        });


        app.get("/projects/assigned", async (req, res) => {
            const { decoratorEmail, search } = req.query;

            const query = {
                bookingStatus: "decorator_assigned",
            };

            if (decoratorEmail) {
                query.decoratorEmail = decoratorEmail;
            }

            if (search) {
                query.serviceName = { $regex: search, $options: "i" };
            }

            const result = await bookingsCollection.find(query).toArray();
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

        app.get("/projects/completed", async (req, res) => {
            try {
                const { decoratorEmail } = req.query;

                const query = {
                    bookingStatus: "completed",
                };

                if (decoratorEmail) {
                    query.decoratorEmail = decoratorEmail;
                }

                const result = await bookingsCollection
                    .find(query)
                    .sort({ updatedAt: -1 })
                    .toArray();

                res.send(result);

            } catch (error) {
                console.error(error);

                res.status(500).send({
                    success: false,
                    message: "Failed to fetch completed projects",
                });
            }
        });

        app.patch("/bookings/:id/project-status", async (req, res) => {
            try {
                const { id } = req.params;
                const { projectStatus } = req.body;

                const allowedStatuses = [
                    "planning",
                    "materials_prepared",
                    "on_the_way",
                    "setup_in_progress",
                    "completed",
                    "rejected",
                ];

                if (!allowedStatuses.includes(projectStatus)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid project status",
                    });
                }

                const booking = await bookingsCollection.findOne({
                    _id: new ObjectId(id),
                });

                if (!booking) {
                    return res.status(404).send({
                        success: false,
                        message: "Booking not found",
                    });
                }

                const updateDoc = {
                    projectStatus,
                    updatedAt: new Date(),
                };

                // Complete হলে booking complete
                if (projectStatus === "completed") {
                    updateDoc.bookingStatus = "completed";
                }

                // Reject হলে booking reject
                if (projectStatus === "rejected") {
                    updateDoc.bookingStatus = "rejected";
                }

                const result = await bookingsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: updateDoc,
                    }
                );

                // Complete বা Reject হলে decorator free
                if (
                    (projectStatus === "completed" ||
                        projectStatus === "rejected") &&
                    booking.decoratorId
                ) {
                    await decoratorsCollection.updateOne(
                        {
                            _id: new ObjectId(booking.decoratorId),
                        },
                        {
                            $set: {
                                workStatus: "available",
                            },
                        }
                    );
                }

                res.send({
                    success: true,
                    modifiedCount: result.modifiedCount,
                });

            } catch (error) {
                console.error("Project Status Update Error:", error);

                res.status(500).send({
                    success: false,
                    message: "Server Error",
                });
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

        app.get("/dashboard/admin/overview", async (req, res) => {
            try {
                const usersCount = await usersCollection.countDocuments();

                const decoratorsCount = await decoratorsCollection.countDocuments();

                const pendingDecorators = await decoratorsCollection.countDocuments({
                    status: "pending",
                });

                const totalBookings = await bookingsCollection.countDocuments();

                const completedProjects = await bookingsCollection.countDocuments({
                    bookingStatus: "completed",
                });

                const revenueAgg = await bookingsCollection.aggregate([
                    {
                        $match: {
                            bookingStatus: "completed",
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            totalRevenue: {
                                $sum: "$servicePrice",
                            },
                        },
                    },
                ]).toArray();

                const totalRevenue = revenueAgg[0]?.totalRevenue || 0;

                const activeProjects = await bookingsCollection.countDocuments({
                    bookingStatus: "decorator_assigned",
                });

                res.send({
                    usersCount,
                    decoratorsCount,
                    pendingDecorators,
                    totalBookings,
                    completedProjects,
                    totalRevenue,
                    activeProjects,
                });
            } catch (error) {
                console.error(error);
                res.status(500).send({ success: false });
            }
        });

        app.get("/dashboard/decorator/overview", async (req, res) => {
            try {
                const { email } = req.query;

                const match = {
                    decoratorEmail: email,
                };

                const assigned = await bookingsCollection.countDocuments({
                    ...match,
                    bookingStatus: "decorator_assigned",
                });

                const completed = await bookingsCollection.countDocuments({
                    ...match,
                    bookingStatus: "completed",
                });

                const active = await bookingsCollection.countDocuments({
                    ...match,
                    projectStatus: {
                        $in: [
                            "planning",
                            "materials_prepared",
                            "on_the_way",
                            "setup_in_progress",
                        ],
                    },
                });

                const earningsAgg = await bookingsCollection.aggregate([
                    {
                        $match: {
                            decoratorEmail: email,
                            bookingStatus: "completed",
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            totalEarnings: {
                                $sum: {
                                    $multiply: ["$servicePrice", 0.6],
                                },
                            },
                        },
                    },
                ]).toArray();

                const totalEarnings = earningsAgg[0]?.totalEarnings || 0;

                res.send({
                    assigned,
                    completed,
                    active,
                    totalEarnings,
                });
            } catch (error) {
                console.error(error);
                res.status(500).send({ success: false });
            }
        });

        app.get("/dashboard/user/overview", async (req, res) => {
            try {
                const { email } = req.query;

                const match = {
                    userEmail: email,
                };

                const totalBookings = await bookingsCollection.countDocuments(match);

                const pending = await bookingsCollection.countDocuments({
                    ...match,
                    bookingStatus: "pending",
                });

                const completed = await bookingsCollection.countDocuments({
                    ...match,
                    bookingStatus: "completed",
                });

                const totalSpentAgg = await bookingsCollection.aggregate([
                    {
                        $match: {
                            userEmail: email,
                            paymentStatus: "paid",
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            totalSpent: {
                                $sum: "$servicePrice",
                            },
                        },
                    },
                ]).toArray();

                const totalSpent = totalSpentAgg[0]?.totalSpent || 0;

                res.send({
                    totalBookings,
                    pending,
                    completed,
                    totalSpent,
                });
            } catch (error) {
                console.error(error);
                res.status(500).send({ success: false });
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