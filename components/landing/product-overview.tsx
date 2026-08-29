'use client';

import React from 'react';
import { MotionSafe } from "@/components/motion-safe";
import { Upload, CheckCircle2, Rocket, X, Check } from 'lucide-react';

export const ProductOverview = () => {
    return (
        <section className="w-full py-24 bg-[#0B0E14] relative">
            <div className="max-w-5xl mx-auto px-6 grid grid-cols-1 md:grid-cols-2 gap-16 lg:gap-24 items-center relative z-10">
                
                {/* Left Column: Problem & Solution */ }
                <div className="space-y-12">
                    <div className="space-y-6">
                        <MotionSafe 
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5 }}
                            className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[#00D4AA]/10 border border-[#00D4AA]/20"
                        >
                            <span className="text-sm font-semibold text-[#00D4AA] ">Product Overview</span>
                        </MotionSafe>

                        <MotionSafe
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.1 }}
                        >
                            <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight relative inline-block">
                                The Problem We Solve
                            </h2>
                        </MotionSafe>
                    </div>

                    <div className="space-y-8">
                        {/* Problem Statement */ }
                        <MotionSafe 
                            initial={{ opacity: 0, x: -20 }}
                            whileInView={{ opacity: 1, x: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.2 }}
                            className="flex items-start gap-5"
                        >
                            <div className="mt-1 flex-shrink-0 w-8 h-8 rounded-sm bg-red-500/10 flex items-center justify-center border border-red-500/20">
                                <X className="w-4 h-4 text-red-400" />
                            </div>
                            <div className="space-y-2">
                                <h3 className="text-lg font-semibold text-white">Manual Crypto Payouts Are Inefficient</h3>
                                <p className="text-[#9CA3AF] text-base leading-relaxed max-w-md">
                                    Processing individual transactions manually is time-consuming, error-prone, and doesn&apos;t scale for teams making regular payments to multiple recipients.
                                </p>
                            </div>
                        </MotionSafe>

                        {/* Solution Statement */ }
                        <MotionSafe 
                            initial={{ opacity: 0, x: -20 }}
                            whileInView={{ opacity: 1, x: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.3 }}
                            className="flex items-start  gap-5"
                        >
                            <div className="mt-1 flex-shrink-0 w-8 h-8 rounded-sm bg-[#00D4AA]/10 flex items-center justify-center border border-[#00D4AA]/20">
                                <Check className="w-4 h-4 text-[#00D4AA]" />
                            </div>
                            <div className="space-y-2">
                                <h3 className="text-lg font-semibold text-white">Batch Payments Enable Automation</h3>
                                <p className="text-[#9CA3AF] text-base leading-relaxed max-w-md">
                                    Stellar BatchPay allows you to upload payment lists, validate recipients, and execute hundreds of transactions in a single batch operation on the Stellar blockchain.
                                </p>
                            </div>
                        </MotionSafe>
                    </div>
                </div>

                {/* Right Column: Process Card */ }
                <MotionSafe 
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.2 }}
                    className="relative"
                >
                    <div className="bg-white/[0.02] border border-white/5 rounded-[32px] p-8 md:p-10 shadow-2xl backdrop-blur-sm relative overflow-hidden">
                        {/* Subtle inner top glow */ }
                        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[80%] h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"></div>
                        
                        <div className="space-y-10">
                            {/* Step 1 */ }
                            <div className="flex gap-5">
                                <div className="flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-xl bg-white/[0.03] border border-white/10">
                                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <g clipPath="url(#clip0_1203_3302)">
                                            <path d="M11.25 4.26953V13.75C11.25 14.4414 10.6914 15 10 15C9.30859 15 8.75 14.4414 8.75 13.75V4.26953L5.88281 7.13672C5.39453 7.625 4.60156 7.625 4.11328 7.13672C3.625 6.64844 3.625 5.85547 4.11328 5.36719L9.11328 0.367188C9.60156 -0.121094 10.3945 -0.121094 10.8828 0.367188L15.8828 5.36719C16.3711 5.85547 16.3711 6.64844 15.8828 7.13672C15.3945 7.625 14.6016 7.625 14.1133 7.13672L11.25 4.26953ZM2.5 13.75H7.5C7.5 15.1289 8.62109 16.25 10 16.25C11.3789 16.25 12.5 15.1289 12.5 13.75H17.5C18.8789 13.75 20 14.8711 20 16.25V17.5C20 18.8789 18.8789 20 17.5 20H2.5C1.12109 20 0 18.8789 0 17.5V16.25C0 14.8711 1.12109 13.75 2.5 13.75ZM16.875 17.8125C17.1236 17.8125 17.3621 17.7137 17.5379 17.5379C17.7137 17.3621 17.8125 17.1236 17.8125 16.875C17.8125 16.6264 17.7137 16.3879 17.5379 16.2121C17.3621 16.0363 17.1236 15.9375 16.875 15.9375C16.6264 15.9375 16.3879 16.0363 16.2121 16.2121C16.0363 16.3879 15.9375 16.6264 15.9375 16.875C15.9375 17.1236 16.0363 17.3621 16.2121 17.5379C16.3879 17.7137 16.6264 17.8125 16.875 17.8125Z" fill="#10B981"/>
                                        </g>
                                        <defs>
                                            <clipPath id="clip0_1203_3302">
                                                <path d="M0 0H20V20H0V0Z" fill="white"/>
                                            </clipPath>
                                        </defs>
                                    </svg>

                                </div>
                                <div className="space-y-1 mt-1">
                                    <h4 className="text-white font-medium text-[17px]">1. Upload Payment Data</h4>
                                    <p className="text-[#8B949E] text-sm leading-relaxed">Import CSV files or paste recipient addresses with amounts</p>
                                </div>
                            </div>

                            {/* Divider */ }
                            <div className="h-px w-full bg-white/5 relative">
                                <div className="absolute left-6 -top-5 w-px h-10 bg-white/5 hidden md:block"></div>
                            </div>

                            {/* Step 2 */ }
                            <div className="flex gap-5">
                                <div className="flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-xl bg-white/[0.03] border border-white/10">
                                    <svg width="18" height="20" viewBox="0 0 18 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <g clipPath="url(#clip0_1203_3305)">
                                            <path d="M13.3828 3.38281C13.8711 2.89453 13.8711 2.10156 13.3828 1.61328C12.8945 1.125 12.1016 1.125 11.6133 1.61328L6.25 6.98047L4.00781 4.73828C3.51953 4.25 2.72656 4.25 2.23828 4.73828C1.75 5.22656 1.75 6.01953 2.23828 6.50781L5.36328 9.63281C5.85156 10.1211 6.64453 10.1211 7.13281 9.63281L13.3828 3.38281ZM17.1328 8.38281C17.6211 7.89453 17.6211 7.10156 17.1328 6.61328C16.6445 6.125 15.8516 6.125 15.3633 6.61328L6.25 15.7305L2.13281 11.6172C1.64453 11.1289 0.851562 11.1289 0.363281 11.6172C-0.125 12.1055 -0.125 12.8984 0.363281 13.3867L5.36328 18.3867C5.85156 18.875 6.64453 18.875 7.13281 18.3867L17.1328 8.38672V8.38281Z" fill="#10B981"/>
                                        </g>
                                        <defs>
                                            <clipPath id="clip0_1203_3305">
                                                <path d="M0 0H17.5V20H0V0Z" fill="white"/>
                                            </clipPath>
                                        </defs>
                                    </svg>

                                </div>
                                <div className="space-y-1 mt-1">
                                    <h4 className="text-white font-medium text-[17px]">2. Validate & Review</h4>
                                    <p className="text-[#8B949E] text-sm leading-relaxed">Automatic validation ensures addresses are correct and balances sufficient</p>
                                </div>
                            </div>

                            {/* Divider */ }
                            <div className="h-px w-full bg-white/5 relative">
                                <div className="absolute left-6 -top-5 w-px h-10 bg-white/5 hidden md:block"></div>
                            </div>

                            {/* Step 3 */ }
                            <div className="flex gap-5">
                                <div className="flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-xl bg-white/[0.03] border border-white/10">
                                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <g clipPath="url(#clip0_1203_3307)">
                                            <path d="M6.11716 15.0352L4.91013 13.8281C4.5781 13.4961 4.46091 13.0156 4.60935 12.5703C4.72654 12.2227 4.88279 11.7696 5.07029 11.25H0.937477C0.601539 11.25 0.289039 11.0703 0.121071 10.7774C-0.0468982 10.4844 -0.0429919 10.125 0.128883 9.83596L2.17966 6.37893C2.68748 5.52346 3.60545 5.00002 4.59763 5.00002H7.81248C7.90623 4.84377 7.99998 4.69924 8.09373 4.55862C11.2929 -0.160134 16.0586 -0.316384 18.9023 0.207054C19.3554 0.289085 19.707 0.644554 19.7929 1.09768C20.3164 3.94533 20.1562 8.70705 15.4414 11.9063C15.3047 12 15.1562 12.0938 15 12.1875V15.4024C15 16.3946 14.4765 17.3164 13.6211 17.8203L10.164 19.8711C9.87498 20.043 9.5156 20.0469 9.22263 19.8789C8.92966 19.711 8.74998 19.4024 8.74998 19.0625V14.875C8.1992 15.0664 7.71873 15.2227 7.35545 15.3399C6.91795 15.4805 6.44138 15.3594 6.11326 15.0352H6.11716ZM15 6.56252C15.4144 6.56252 15.8118 6.3979 16.1048 6.10488C16.3979 5.81185 16.5625 5.41442 16.5625 5.00002C16.5625 4.58562 16.3979 4.18819 16.1048 3.89517C15.8118 3.60214 15.4144 3.43752 15 3.43752C14.5856 3.43752 14.1881 3.60214 13.8951 3.89517C13.6021 4.18819 13.4375 4.58562 13.4375 5.00002C13.4375 5.41442 13.6021 5.81185 13.8951 6.10488C14.1881 6.3979 14.5856 6.56252 15 6.56252Z" fill="#10B981"/>
                                        </g>
                                        <defs>
                                            <clipPath id="clip0_1203_3307">
                                                <path d="M0 0H20V20H0V0Z" fill="white"/>
                                            </clipPath>
                                        </defs>
                                    </svg>

                                </div>
                                <div className="space-y-1 mt-1">
                                    <h4 className="text-white font-medium text-[18px]">3. Execute Batch</h4>
                                    <p className="text-[#8B949E] text-[14px] leading-relaxed">Process all payments in one transaction with full transparency</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </MotionSafe>

            </div>

        </section>
    );
};
